import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import type { HostPackage } from "../gate/model.ts";
import { declaredHostPackages, installedHostPackages, lockedHostPackages } from "../host-packages.ts";

export const STAGES = ["deps", "install", "update", "check", "test", "gate", "verify"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_COMMANDS: Readonly<Record<Stage, string>> = {
	deps: "bun deps.ts check",
	install: "bun install --frozen-lockfile",
	update: "bun update <@oh-my-pi packages>",
	check: "bun run check",
	test: "bun run test",
	gate: "bun deps.ts gate",
	verify: "bun verify.ts",
};

const STEP_OUTCOME = z.enum(["success", "failure", "cancelled", "skipped"]);
export type StepOutcome = z.infer<typeof STEP_OUTCOME>;
const STEPS = z.record(z.string(), z.object({ outcome: STEP_OUTCOME }));
export type Steps = ReadonlyMap<string, StepOutcome>;

export const JOB_STATUSES = ["success", "failure"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type FailedAt = { readonly kind: "stage"; readonly stage: Stage } | { readonly kind: "setup" };

export type CheckRun =
	| { readonly kind: "passed" }
	| { readonly kind: "failed"; readonly at: FailedAt; readonly head: string; readonly excerpt: string };

export type VersionSource = "gate-summary" | "node_modules" | "bun.lock" | "package.json";

export type Versions = { readonly source: VersionSource; readonly packages: readonly HostPackage[] } | { readonly source: "none" };

const GATE_SUMMARY = z.object({
	hostPackages: z.array(z.object({ name: z.string(), version: z.string() })),
	failures: z.array(z.object({ message: z.string() })),
});
export type GateSummary = z.infer<typeof GATE_SUMMARY>;

const ERROR_LINE = /\berror\b|\bfail(?:ed|ure|s)?\b|✗|\(fail\)/i;
const BUN_DOWNLOAD_ERROR = /^(error: \w+ downloading (?:tarball|package manifest)) \S+$/;
const DOWNLOADS_PACKAGES: Readonly<Record<Stage, boolean>> = {
	deps: false,
	install: true,
	update: true,
	check: false,
	test: false,
	gate: false,
	verify: false,
};
const HEAD_MAX = 300;
const EXCERPT_HEAD_LINES = 40;
const EXCERPT_TAIL_LINES = 80;
const EXCERPT_MAX_CHARS = 20_000;

export function parseSteps(json: string): { readonly ok: true; readonly steps: Steps } | { readonly ok: false; readonly reason: string } {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		return { ok: false, reason: `steps are not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const parsed = STEPS.safeParse(value);
	if (!parsed.success) return { ok: false, reason: `steps do not match {<id>: {outcome}}: ${parsed.error.message}` };
	return { ok: true, steps: new Map(Object.entries(parsed.data).map(([id, step]) => [id, step.outcome])) };
}

export function readGateSummary(file: string): GateSummary | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = GATE_SUMMARY.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

export function failedAt(steps: Steps, jobStatus: JobStatus): FailedAt | undefined {
	const stage = STAGES.find((id) => steps.get(id) === "failure");
	if (stage !== undefined) return { kind: "stage", stage };
	return jobStatus === "failure" ? { kind: "setup" } : undefined;
}

function readLog(logs: string, stage: Stage): string | undefined {
	try {
		return readFileSync(path.join(logs, `${stage}.log`), "utf8");
	} catch {
		return undefined;
	}
}

export function normalizeHead(line: string): string {
	return line
		.replace(/\/home\/runner\/work\/[^/\s]+\/[^/\s]+\//g, "")
		.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "<duration>")
		.replace(/\b[0-9a-f]{12,40}\b/g, "<sha>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, HEAD_MAX);
}

export function errorHead(log: string, stage: Stage): string {
	const lines = Bun.stripANSI(log)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const line = lines.find((candidate) => ERROR_LINE.test(candidate)) ?? lines.at(-1);
	if (line === undefined) return "(no output)";
	return normalizeHead(DOWNLOADS_PACKAGES[stage] ? line.replace(BUN_DOWNLOAD_ERROR, "$1 <package>") : line);
}

export function excerpt(log: string): string {
	const lines = Bun.stripANSI(log).trimEnd().split("\n");
	const kept =
		lines.length <= EXCERPT_HEAD_LINES + EXCERPT_TAIL_LINES
			? lines
			: [
					...lines.slice(0, EXCERPT_HEAD_LINES),
					`… ${lines.length - EXCERPT_HEAD_LINES - EXCERPT_TAIL_LINES} lines omitted …`,
					...lines.slice(-EXCERPT_TAIL_LINES),
				];
	const text = kept.join("\n");
	if (text.length <= EXCERPT_MAX_CHARS) return text;
	const front = Math.floor(EXCERPT_MAX_CHARS / 4);
	const back = EXCERPT_MAX_CHARS - front;
	return `${text.slice(0, front)}\n… ${text.length - EXCERPT_MAX_CHARS} characters omitted …\n${text.slice(-back)}`;
}

export function observeRun(input: {
	readonly steps: Steps;
	readonly jobStatus: JobStatus;
	readonly logs: string;
	readonly gateSummary: GateSummary | undefined;
}): CheckRun {
	const at = failedAt(input.steps, input.jobStatus);
	if (at === undefined) return { kind: "passed" };
	if (at.kind === "setup") {
		return {
			kind: "failed",
			at,
			head: "a workflow step outside the check stages failed",
			excerpt: "(no stage log: the failing step is not one of the check stages; see the Actions run)",
		};
	}
	const log = readLog(input.logs, at.stage);
	const gateHead = at.stage === "gate" ? input.gateSummary?.failures[0]?.message : undefined;
	return {
		kind: "failed",
		at,
		head: gateHead !== undefined ? normalizeHead(gateHead) : log === undefined ? "(no log captured)" : errorHead(log, at.stage),
		excerpt: log === undefined ? "(no log captured)" : excerpt(log),
	};
}

export function hostVersions(root: string, steps: Steps, gateSummary: GateSummary | undefined): Versions {
	if (gateSummary !== undefined) return { source: "gate-summary", packages: gateSummary.hostPackages };
	if (steps.get("install") === "success" && steps.get("update") === "success") {
		return { source: "node_modules", packages: installedHostPackages(root) };
	}
	const locked = lockedHostPackages(root);
	if (locked !== undefined) return { source: "bun.lock", packages: locked };
	const declared = declaredHostPackages(root);
	if (declared !== undefined) return { source: "package.json", packages: declared };
	return { source: "none" };
}
