import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Manifest, parseManifest } from "../lib/deps.ts";
import { openTsHost } from "../lib/gate/ts-project.ts";
import { checkUpstreamExports, installedHostPackages } from "../lib/gate/upstream.ts";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "omomp-gate-upstream-")));
const root = path.join(scratch, "repo");

function write(relative: string, text: string, base = root): string {
	const file = path.join(base, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
	return relative;
}

mkdirSync(root, { recursive: true });
symlinkSync(path.join(import.meta.dir, "..", "node_modules"), path.join(root, "node_modules"));
writeFileSync(
	path.join(root, "package.json"),
	JSON.stringify({ name: "gate-upstream-fixture", devDependencies: { "@oh-my-pi/omptype": "latest" } }),
);

const PASSING = write(
	"agent/passing.ts",
	[
		`import { z } from "@oh-my-pi/pi-coding-agent";`,
		`import { z as omptypeZ } from "@oh-my-pi/omptype/zod";`,
		`import agentCore = require("@oh-my-pi/pi-agent-core");`,
		`import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";`,
		`export * from "@oh-my-pi/pi-coding-agent/async";`,
		`export * as asyncApi from "@oh-my-pi/pi-coding-agent/async";`,
		``,
	].join("\n"),
);
const BROKEN = write(
	"agent/broken.ts",
	[
		`import "@oh-my-pi/pi-wire";`,
		`import { sdkEntry } from "@oh-my-pi/pi-coding-agent/sdk";`,
		`import { missingValue, ZodLikeSchema } from "@oh-my-pi/omptype/zod";`,
		`import type { NoSuchType } from "@oh-my-pi/pi-coding-agent";`,
		`void import("@oh-my-pi/pi-coding-agent/sdk");`,
		``,
	].join("\n"),
);
const INTERNAL = write("test/internal.ts", `import { sdkEntry } from "@oh-my-pi/pi-coding-agent/sdk";\n`);
const UNMANIFESTED = write(
	"agent/unmanifested.ts",
	[`import { z } from "@oh-my-pi/omptype/zod";`, `import "@oh-my-pi/pi-wire";`, ``].join("\n"),
);

const host = openTsHost(root);
const declared = manifestFor({ devDependencies: { "@oh-my-pi/omptype": "latest" } });
const zodTarget = relativeTarget(Bun.resolveSync("@oh-my-pi/omptype/zod", path.join(root, "package.json")));

afterAll(async () => {
	await host.close();
	rmSync(scratch, { recursive: true, force: true });
});

function manifestFor(value: object): Manifest {
	const parsed = parseManifest(JSON.stringify(value));
	if (!parsed.ok) throw new Error("fixture package.json must parse");
	return parsed.manifest;
}

function relativeTarget(target: string): string {
	return path.relative(root, target).split(path.sep).join("/");
}

function sources(
	production: readonly string[],
	nonProduction: readonly string[] = [],
): {
	readonly production: readonly string[];
	readonly nonProduction: readonly string[];
	readonly tests: readonly string[];
} {
	return { production, nonProduction, tests: [] };
}

describe("installedHostPackages", () => {
	test("returns no packages when the @oh-my-pi scope directory is absent", async () => {
		const empty = mkdtempSync(path.join(scratch, "empty-"));
		expect(await installedHostPackages(empty)).toEqual([]);
	});

	test("reads name and version from each installed package and sorts by name", async () => {
		const synthetic = mkdtempSync(path.join(scratch, "synthetic-"));
		const scope = path.join(synthetic, "node_modules", "@oh-my-pi");
		const packageAt = (dir: string, value: object): void => {
			mkdirSync(path.join(scope, dir), { recursive: true });
			writeFileSync(path.join(scope, dir, "package.json"), JSON.stringify(value));
		};
		packageAt("zzz", { name: "@oh-my-pi/alpha", version: "1.0.0" });
		packageAt("aaa", { name: "@oh-my-pi/zeta", version: "2.3.4" });
		packageAt("no-version", { name: "@oh-my-pi/broken" });
		writeFileSync(path.join(scope, "loose-file"), "");
		expect(await installedHostPackages(synthetic)).toEqual([
			{ name: "@oh-my-pi/alpha", version: "1.0.0" },
			{ name: "@oh-my-pi/zeta", version: "2.3.4" },
		]);
	});
});

describe("checkUpstreamExports", () => {
	test("accepts the bundled root shim, declared wildcard subpaths and type-only imports", async () => {
		const result = await checkUpstreamExports({
			root,
			manifest: declared,
			sources: sources([PASSING]),
			host,
		});
		expect(result).toEqual({ failures: [], nonProduction: [] });
	});

	test("separates bundled subpaths, undeclared packages and absent symbols, reporting non-production sites apart", async () => {
		const result = await checkUpstreamExports({
			root,
			manifest: declared,
			sources: sources([BROKEN], [INTERNAL]),
			host,
		});
		expect(result.failures).toEqual([
			{
				kind: "undeclared-package",
				site: { file: "agent/broken.ts", line: 1, specifier: "@oh-my-pi/pi-wire" },
				package: "@oh-my-pi/pi-wire",
			},
			{
				kind: "unbundled-subpath",
				site: { file: "agent/broken.ts", line: 2, specifier: "@oh-my-pi/pi-coding-agent/sdk" },
				package: "@oh-my-pi/pi-coding-agent",
			},
			{
				kind: "type-only-export",
				site: { file: "agent/broken.ts", line: 3, specifier: "@oh-my-pi/omptype/zod" },
				symbol: "ZodLikeSchema",
				target: zodTarget,
			},
			{
				kind: "missing-export",
				site: { file: "agent/broken.ts", line: 3, specifier: "@oh-my-pi/omptype/zod" },
				symbol: "missingValue",
				target: zodTarget,
			},
			{
				kind: "missing-type-export",
				site: { file: "agent/broken.ts", line: 4, specifier: "@oh-my-pi/pi-coding-agent" },
				symbol: "NoSuchType",
				target: "@oh-my-pi/pi-coding-agent",
			},
			{
				kind: "unbundled-subpath",
				site: { file: "agent/broken.ts", line: 5, specifier: "@oh-my-pi/pi-coding-agent/sdk" },
				package: "@oh-my-pi/pi-coding-agent",
			},
		]);
		expect(result.nonProduction).toEqual([
			{
				kind: "unbundled-subpath",
				site: { file: "test/internal.ts", line: 1, specifier: "@oh-my-pi/pi-coding-agent/sdk" },
				package: "@oh-my-pi/pi-coding-agent",
			},
		]);
	});

	test("reports one module-table failure and stops path and symbol checks when the host module table is unavailable", async () => {
		const isolated = path.join(scratch, "without-host");
		write(UNMANIFESTED, `import { z } from "@oh-my-pi/omptype/zod";\nimport "@oh-my-pi/pi-wire";\n`, isolated);
		const result = await checkUpstreamExports({
			root: isolated,
			manifest: declared,
			sources: sources([UNMANIFESTED]),
			host,
		});
		expect(result.nonProduction).toEqual([]);
		expect(result.failures.map((failure) => failure.kind)).toEqual(["module-table-unavailable"]);
		const [failure] = result.failures;
		if (failure?.kind !== "module-table-unavailable") throw new Error("expected a module table failure");
		expect(failure.reason).toContain("pi-coding-agent");
	});

	test("rejects every non-bundled @oh-my-pi package when no manifest declares it", async () => {
		const result = await checkUpstreamExports({
			root,
			manifest: undefined,
			sources: sources([UNMANIFESTED]),
			host,
		});
		expect(result).toEqual({
			failures: [
				{
					kind: "undeclared-package",
					site: { file: "agent/unmanifested.ts", line: 1, specifier: "@oh-my-pi/omptype/zod" },
					package: "@oh-my-pi/omptype",
				},
				{
					kind: "undeclared-package",
					site: { file: "agent/unmanifested.ts", line: 2, specifier: "@oh-my-pi/pi-wire" },
					package: "@oh-my-pi/pi-wire",
				},
			],
			nonProduction: [],
		});
	});
});
