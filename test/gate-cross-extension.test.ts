import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkCrossExtensionImports } from "../lib/gate/cross-extension.ts";
import type { GateFailure, GatedShape } from "../lib/gate/model.ts";
import { openTsHost, type TsHost, type TsProject } from "../lib/gate/ts-project.ts";

type Shape = Extract<GatedShape, { readonly kind: "plugin-multi" | "config-bundle" }>;

const TS_CONFIG = {
	compilerOptions: {
		target: "ESNext",
		module: "Preserve",
		moduleResolution: "bundler",
		allowImportingTsExtensions: true,
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: [],
	},
};

const PLUGIN_ENTRIES = ["extensions/a/index.ts", "extensions/b/util.ts"];

const FILES: Readonly<Record<string, string>> = {
	"extensions/a/index.ts": [
		'import { util } from "../b/util.ts";',
		'import { shared } from "../_shared/x.ts";',
		'import { local } from "./local.ts";',
		"export const value = `${util} ${shared} ${local}`;",
		"",
	].join("\n"),
	"extensions/a/clean.ts": [
		'import { shared } from "../_shared/x.ts";',
		'import { local } from "./local.ts";',
		"export const clean = `${shared} ${local}`;",
		"",
	].join("\n"),
	"extensions/a/typed.ts": ['import type { Thing } from "../b/types.ts";', "export const thing: Thing = 1;", ""].join("\n"),
	"extensions/a/dynamic.ts": ['export const load = () => import("../b/z.ts");', ""].join("\n"),
	"extensions/a/required.ts": ['import z = require("../b/q.ts");', "export const q = z;", ""].join("\n"),
	"extensions/a/local.ts": ["export const local = 1;", ""].join("\n"),
	"extensions/b/util.ts": ["export const util = 1;", ""].join("\n"),
	"extensions/b/types.ts": ["export type Thing = number;", ""].join("\n"),
	"extensions/b/z.ts": ["export const z = 1;", ""].join("\n"),
	"extensions/b/q.ts": ["export const q = 1;", ""].join("\n"),
	"extensions/_shared/x.ts": ["export const shared = 1;", ""].join("\n"),
	"agent/extensions/a/x.ts": [
		'import { y } from "../../extensions-last/b/y.ts";',
		'import { i18n } from "../_shared/omomp-shared/i18n.ts";',
		"export const x = `${y} ${i18n}`;",
		"",
	].join("\n"),
	"agent/extensions/a/shared-only.ts": [
		'import { i18n } from "../_shared/omomp-shared/i18n.ts";',
		"export const shared = i18n;",
		"",
	].join("\n"),
	"agent/extensions-last/b/y.ts": ["export const y = 2;", ""].join("\n"),
	"agent/extensions/_shared/omomp-shared/i18n.ts": ['export const i18n = "text";', ""].join("\n"),
};

let root = "";
let host: TsHost | undefined;
let project: TsProject | undefined;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omomp-gate-cross-"));
	await writeFile(path.join(root, "tsconfig.json"), `${JSON.stringify(TS_CONFIG, null, "\t")}\n`);
	for (const [file, text] of Object.entries(FILES)) {
		const target = path.join(root, file);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, text);
	}
	host = openTsHost(root);
	project = await host.open(Object.keys(FILES).map((file) => path.join(root, file)));
});

afterAll(async () => {
	await host?.close();
	await rm(root, { recursive: true, force: true });
});

async function failuresOf(shape: Shape, files: readonly string[]): Promise<GateFailure[]> {
	if (project === undefined) throw new Error("the fixture project is not open");
	return checkCrossExtensionImports({
		root,
		shape,
		production: files.map((file) => path.join(root, file)),
		project,
	});
}

describe("plugin-multi", () => {
	test("reports a relative import into another extension with from and to", async () => {
		const failures = await failuresOf({ kind: "plugin-multi", entries: PLUGIN_ENTRIES }, ["extensions/a/index.ts"]);
		expect(failures).toEqual([
			{
				kind: "cross-extension-import",
				site: { file: "extensions/a/index.ts", line: 1, specifier: "../b/util.ts" },
				from: "extensions/a",
				to: "extensions/b",
			},
		]);
	});

	test("allows shared and same-extension relative imports", async () => {
		const failures = await failuresOf({ kind: "plugin-multi", entries: PLUGIN_ENTRIES }, ["extensions/a/clean.ts"]);
		expect(failures).toEqual([]);
	});

	test("reports a type-only import into another extension", async () => {
		const failures = await failuresOf({ kind: "plugin-multi", entries: PLUGIN_ENTRIES }, ["extensions/a/typed.ts"]);
		expect(failures).toEqual([
			{
				kind: "cross-extension-import",
				site: { file: "extensions/a/typed.ts", line: 1, specifier: "../b/types.ts" },
				from: "extensions/a",
				to: "extensions/b",
			},
		]);
	});

	test("reports a dynamic import into another extension", async () => {
		const failures = await failuresOf({ kind: "plugin-multi", entries: PLUGIN_ENTRIES }, ["extensions/a/dynamic.ts"]);
		expect(failures).toEqual([
			{
				kind: "cross-extension-import",
				site: { file: "extensions/a/dynamic.ts", line: 1, specifier: "../b/z.ts" },
				from: "extensions/a",
				to: "extensions/b",
			},
		]);
	});

	test("reports an import-equals require into another extension", async () => {
		const failures = await failuresOf({ kind: "plugin-multi", entries: PLUGIN_ENTRIES }, ["extensions/a/required.ts"]);
		expect(failures).toEqual([
			{
				kind: "cross-extension-import",
				site: { file: "extensions/a/required.ts", line: 1, specifier: "../b/q.ts" },
				from: "extensions/a",
				to: "extensions/b",
			},
		]);
	});

	test("sorts failures by file and line", async () => {
		const failures = await failuresOf({ kind: "plugin-multi", entries: PLUGIN_ENTRIES }, [
			"extensions/a/typed.ts",
			"extensions/a/index.ts",
			"extensions/a/dynamic.ts",
		]);
		expect(failures.map((failure) => (failure.kind === "cross-extension-import" ? failure.site.file : ""))).toEqual([
			"extensions/a/dynamic.ts",
			"extensions/a/index.ts",
			"extensions/a/typed.ts",
		]);
	});
});

describe("config-bundle", () => {
	test("reports an import from agent/extensions into agent/extensions-last", async () => {
		const failures = await failuresOf({ kind: "config-bundle" }, ["agent/extensions/a/x.ts", "agent/extensions-last/b/y.ts"]);
		expect(failures).toEqual([
			{
				kind: "cross-extension-import",
				site: { file: "agent/extensions/a/x.ts", line: 1, specifier: "../../extensions-last/b/y.ts" },
				from: "agent/extensions/a",
				to: "agent/extensions-last/b",
			},
		]);
	});

	test("allows an import into the shared directory", async () => {
		const failures = await failuresOf({ kind: "config-bundle" }, ["agent/extensions/a/shared-only.ts"]);
		expect(failures).toEqual([]);
	});
});
