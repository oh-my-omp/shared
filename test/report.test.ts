import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { errorHead, excerpt, hostVersions, observeRun, parseSteps, type Steps } from "../lib/report/check-run.ts";
import {
	bodyOf,
	type Context,
	decide,
	type Failure,
	findTracked,
	fingerprintOf,
	formatTime,
	markerOf,
	observe,
	refreshedBody,
	type Tracked,
} from "../lib/report/tracking.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "omomp-report-"));

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function directory(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(scratch, "dir-"));
	for (const [relative, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
		writeFileSync(path.join(root, relative), text);
	}
	return root;
}

function steps(outcomes: Record<string, "success" | "failure" | "skipped">): Steps {
	const parsed = parseSteps(
		JSON.stringify(
			Object.fromEntries(Object.entries(outcomes).map(([id, outcome]) => [id, { outcome, conclusion: outcome, outputs: {} }])),
		),
	);
	if (!parsed.ok) throw new Error(parsed.reason);
	return parsed.steps;
}

const LOCK = `{ "lockfileVersion": 1, "packages": { "@oh-my-pi/pi-utils": ["@oh-my-pi/pi-utils@19.1.0", "", {}, "sha512-x"], }, }`;
const MANIFEST = JSON.stringify({ devDependencies: { "@oh-my-pi/pi-utils": "latest" } });

describe("observeRun", () => {
	test("names the first failing stage in check order, not in step order, with its log head and excerpt", () => {
		const logs = directory({ "test.log": "$ bun test\n(fail) a > b\nerror: expected 1\n", "check.log": "error TS2305: no export\n" });
		const run = observeRun({
			steps: steps({ test: "failure", check: "failure", deps: "success" }),
			jobStatus: "failure",
			logs,
			gateSummary: undefined,
		});
		expect(run).toEqual({
			kind: "failed",
			at: { kind: "stage", stage: "check" },
			head: "error TS2305: no export",
			excerpt: "error TS2305: no export",
		});
	});

	test("reports a failure outside the stages as setup when the job failed and no stage did", () => {
		const run = observeRun({ steps: steps({ deps: "skipped" }), jobStatus: "failure", logs: directory({}), gateSummary: undefined });
		expect(run.kind === "failed" && run.at).toEqual({ kind: "setup" });
	});

	test("passes when the job succeeded", () => {
		expect(
			observeRun({ steps: steps({ deps: "success", gate: "success" }), jobStatus: "success", logs: directory({}), gateSummary: undefined }),
		).toEqual({
			kind: "passed",
		});
	});

	test("takes the gate head from the gate summary's first failure", () => {
		const run = observeRun({
			steps: steps({ gate: "failure" }),
			jobStatus: "failure",
			logs: directory({ "gate.log": "/r: shape plugin-single\n/r: 2 gate failures\n" }),
			gateSummary: { hostPackages: [], failures: [{ message: "index.ts:3 'x': 'y' is not exported by z" }, { message: "second" }] },
		});
		expect(run.kind === "failed" && run.head).toBe("index.ts:3 'x': 'y' is not exported by z");
	});

	test("keeps the stage and says so when the failing stage left no log", () => {
		const run = observeRun({ steps: steps({ install: "failure" }), jobStatus: "failure", logs: directory({}), gateSummary: undefined });
		expect(run).toEqual({
			kind: "failed",
			at: { kind: "stage", stage: "install" },
			head: "(no log captured)",
			excerpt: "(no log captured)",
		});
	});
});

describe("errorHead", () => {
	test("picks the first error line and normalizes ANSI, durations, runner paths and hashes", () => {
		const log =
			"\u001b[1mbun install\u001b[0m\nResolving [12.5ms]\nerror: Cannot find module './x' from '/home/runner/work/omp-config/omp-config/repository/a.ts' [340ms] in 0123456789abcdef\n";
		expect(errorHead(log)).toBe("error: Cannot find module './x' from 'repository/a.ts' [<duration>] in <sha>");
	});

	test("falls back to the last non-empty line, then to a placeholder", () => {
		expect(errorHead("first\nlast line\n\n")).toBe("last line");
		expect(errorHead("\n\n")).toBe("(no output)");
	});
});

describe("excerpt", () => {
	test("keeps logs of up to 120 lines whole and cuts longer ones to the first 40 and last 80", () => {
		const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
		expect(excerpt(lines(120))).toBe(lines(120));
		const cut = excerpt(lines(121)).split("\n");
		expect(cut).toHaveLength(121);
		expect(cut[39]).toBe("line 40");
		expect(cut[40]).toBe("… 1 lines omitted …");
		expect(cut[41]).toBe("line 42");
		expect(cut.at(-1)).toBe("line 121");
	});

	test("caps the excerpt at 20000 characters, keeping its start and end", () => {
		const long = `HEAD${"x".repeat(50_000)}TAIL`;
		const cut = excerpt(long);
		expect(cut.startsWith("HEAD")).toBe(true);
		expect(cut.endsWith("TAIL")).toBe(true);
		expect(cut).toContain("… 30008 characters omitted …");
	});
});

describe("hostVersions", () => {
	test("prefers the gate summary, then node_modules after a successful install and update, then bun.lock, then package.json", () => {
		const root = directory({
			"bun.lock": LOCK,
			"package.json": MANIFEST,
			"node_modules/@oh-my-pi/pi-utils/package.json": JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "19.2.1" }),
		});
		const summary = { hostPackages: [{ name: "@oh-my-pi/pi-utils", version: "19.3.0" }], failures: [] };
		expect(hostVersions(root, steps({ install: "success", update: "success" }), summary)).toEqual({
			source: "gate-summary",
			packages: summary.hostPackages,
		});
		expect(hostVersions(root, steps({ install: "success", update: "success" }), undefined)).toEqual({
			source: "node_modules",
			packages: [{ name: "@oh-my-pi/pi-utils", version: "19.2.1" }],
		});
		expect(hostVersions(root, steps({ install: "success", update: "failure" }), undefined)).toEqual({
			source: "bun.lock",
			packages: [{ name: "@oh-my-pi/pi-utils", version: "19.1.0" }],
		});
		expect(hostVersions(directory({ "package.json": MANIFEST }), steps({ install: "failure" }), undefined)).toEqual({
			source: "package.json",
			packages: [{ name: "@oh-my-pi/pi-utils", version: "latest" }],
		});
		expect(hostVersions(directory({}), steps({ deps: "failure" }), undefined)).toEqual({ source: "none" });
	});
});

describe("tracking state machine", () => {
	const failure: Failure = { kind: "failed", at: { kind: "stage", stage: "update" }, head: "error: boom", excerpt: "error: boom" };
	const versions = { source: "bun.lock", packages: [{ name: "@oh-my-pi/pi-coding-agent", version: "19.2.1" }] } as const;
	const observed = observe(failure, versions);
	const fingerprint = fingerprintOf(failure, versions);
	const tracked = (print: string | undefined): Tracked => ({
		number: 7,
		url: "u",
		body: "",
		fingerprint: print,
		firstFailed: "2026-11-20T18:00:00.000Z",
	});

	test("creates on a failure with no tracking issue, refreshes the body for the same fingerprint, comments when it changes", () => {
		expect(decide(observed, undefined).kind).toBe("create");
		expect(decide(observed, tracked(fingerprint)).kind).toBe("refresh-body");
		expect(decide(observed, tracked("0000000000000000")).kind).toBe("update-and-comment");
	});

	test("closes the tracking issue when the check passes and does nothing without one", () => {
		expect(decide({ kind: "passed" }, tracked(fingerprint))).toEqual({ kind: "close", issue: tracked(fingerprint) });
		expect(decide({ kind: "passed" }, undefined)).toEqual({ kind: "noop" });
	});

	test("changes the fingerprint with the stage, the error head or the versions, and only with them", () => {
		expect(fingerprintOf({ ...failure, excerpt: "other output" }, versions)).toBe(fingerprint);
		expect(fingerprintOf({ ...failure, at: { kind: "stage", stage: "install" } }, versions)).not.toBe(fingerprint);
		expect(fingerprintOf({ ...failure, head: "error: other" }, versions)).not.toBe(fingerprint);
		expect(fingerprintOf(failure, { source: "bun.lock", packages: [{ name: "@oh-my-pi/pi-coding-agent", version: "19.3.0" }] })).not.toBe(
			fingerprint,
		);
	});

	test("finds the issue carrying this scope's marker and reads back the fingerprint and first failure it wrote", () => {
		const ctx: Context = { subject: "oh-my-omp/shared", scope: "shared", runUrl: "https://run", now: new Date("2026-11-27T18:03:00Z") };
		const body = bodyOf({ ctx, failure, versions, fingerprint, firstFailed: "2026-11-20T18:00:00.000Z" });
		const issues = [
			{ number: 3, url: "repo-scope", body: `${markerOf("repo")}\n<!-- omomp-upstream-check-fingerprint:aaaa -->` },
			{ number: 9, url: "later", body },
			{ number: 5, url: "shared-scope", body },
			{ number: 1, url: "unrelated", body: "no marker" },
			{
				number: 2,
				url: "quotes the marker",
				body: `Acceptance: the reporter keeps one issue marked \`${markerOf("shared")}\`.\n${markerOf("shared")}`,
			},
		];
		expect(findTracked(issues, "shared")).toEqual({
			number: 5,
			url: "shared-scope",
			body,
			fingerprint,
			firstFailed: "2026-11-20T18:00:00.000Z",
		});
		expect(findTracked(issues.slice(3), "shared")).toBeUndefined();
		const damaged = body.replace("first-failed:2026-11-20T18:00:00.000Z", "first-failed:(edited)");
		expect(findTracked([{ number: 5, url: "u", body: damaged }], "shared")?.firstFailed).toBeUndefined();
		expect(body).toContain("| 首次失败 | 2026-11-20 18:00 UTC / 2026-11-21 03:00 GMT+9 |");
		expect(body).toContain("| 最近一次失败 | 2026-11-27 18:03 UTC / 2026-11-28 03:03 GMT+9 |");
	});
});

describe("refreshedBody", () => {
	const failure: Failure = { kind: "failed", at: { kind: "stage", stage: "test" }, head: "error: x", excerpt: "first run output" };
	const versions = { source: "none" } as const;
	const first: Context = { subject: "s", scope: "repo", runUrl: "https://run/1", now: new Date("2026-11-26T18:02:00Z") };
	const body = bodyOf({
		ctx: first,
		failure,
		versions,
		fingerprint: fingerprintOf(failure, versions),
		firstFailed: first.now.toISOString(),
	});

	test("changes only the latest-failure time and run link, keeping the rest of the body", () => {
		const next: Context = { ...first, runUrl: "https://run/2", now: new Date("2026-11-27T18:04:00Z") };
		const refreshed = refreshedBody(body, next) ?? "";
		const differing = body.split("\n").flatMap((line, i) => (line === refreshed.split("\n")[i] ? [] : [refreshed.split("\n")[i]]));
		expect(differing).toEqual(["| 最近一次失败 | 2026-11-27 18:04 UTC / 2026-11-28 03:04 GMT+9 |", "| 最近一次 run | https://run/2 |"]);
	});

	test("returns undefined when a person removed the rows, so the caller rewrites the whole body", () => {
		expect(refreshedBody(body.replace(/^\| 最近一次 run \|.*$/m, ""), first)).toBeUndefined();
	});
});

describe("formatTime", () => {
	test("prints the minute in UTC and in GMT+9 across a date change", () => {
		expect(formatTime(new Date("2026-12-31T15:30:59Z"))).toBe("2026-12-31 15:30 UTC / 2027-01-01 00:30 GMT+9");
	});
});
