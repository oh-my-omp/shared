import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkChainedCasts } from "../lib/gate/casts.ts";
import type { GateFailure } from "../lib/gate/model.ts";
import { openTsHost, type TsHost, type TsProject } from "../lib/gate/ts-project.ts";

const LONG_CAST = `alpha as unknown as { ${["aaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"].map((name) => `readonly ${name}: string`).join("; ")} }`;

const FILES: Readonly<Record<string, string>> = {
	"src/unmarked.ts": ["export function unmarked(value: unknown): string {", "\treturn value as unknown as string;", "}"].join("\n"),
	"src/parenthesized.ts": [
		"export function parenthesized(value: string | number): string {",
		"\treturn (value as unknown) as string;",
		"}",
	].join("\n"),
	"src/angle.ts": ["export function angle(value: unknown): string {", "\treturn <string><unknown>value;", "}"].join("\n"),
	"src/mixed.ts": ["export function mixed(value: unknown): string {", "\treturn <string>(value as unknown);", "}"].join("\n"),
	"src/triple.ts": [
		"export function triple(value: unknown): string {",
		"\treturn value as unknown as number as unknown as string;",
		"}",
	].join("\n"),
	"src/separate.ts": [
		"export function separate(value: unknown, other: unknown): readonly unknown[] {",
		"\treturn [((value as unknown) as string), other as unknown as number];",
		"}",
	].join("\n"),
	"src/marked-above.ts": [
		"export function above(value: unknown): string {",
		"\t// SAFETY: the caller validates the payload shape",
		"\treturn value as unknown as string;",
		"}",
	].join("\n"),
	"src/marked-trailing.ts": [
		"export function trailing(value: unknown): string {",
		"\treturn value as unknown as string; // SAFETY: the caller validates the payload shape",
		"}",
	].join("\n"),
	"src/marked-statement.ts": [
		"export function statement(value: unknown): string {",
		"\t// SAFETY: the caller validates the payload shape",
		"\tconst result =",
		"\t\tvalue as unknown as string;",
		"\treturn result;",
		"}",
	].join("\n"),
	"src/tight-marker.ts": [
		"export function tight(value: unknown): string {",
		"\t//SAFETY: the caller validates the payload shape",
		"\treturn value as unknown as string;",
		"}",
	].join("\n"),
	"src/empty-reason.ts": [
		"export function empty(value: unknown): string {",
		"\t// SAFETY:",
		"\treturn value as unknown as string;",
		"}",
	].join("\n"),
	"src/padded-reason.ts": [
		"export function padded(value: unknown): string {",
		"\t// SAFETY:   ",
		"\treturn value as unknown as string;",
		"}",
	].join("\n"),
	"src/distant.ts": [
		"export function distant(value: unknown): string {",
		"\tconst offset = 1;",
		"\t// SAFETY: this marker is two lines above the cast",
		"",
		"\treturn value as unknown as string;",
		"}",
	].join("\n"),
	"src/template.ts": [
		"export function template(value: unknown): string {",
		"\tconst noise = `$" + "{1}",
		"// SAFETY: only template text`;",
		"\treturn value as unknown as string;",
		"}",
	].join("\n"),
	"src/class-blessing.ts": [
		"// SAFETY: the whole class is audited",
		"class Box {",
		"\tvalue = (input as unknown) as string;",
		"\t// SAFETY: the member is audited",
		"\tother = input as unknown as number;",
		"}",
		"",
		"declare const input: unknown;",
		"",
		"export { Box };",
	].join("\n"),
	"src/single-as.ts": ["export function single(value: unknown): string {", "\treturn value as string;", "}"].join("\n"),
	"src/satisfies.ts": [
		"type Config = { readonly retries: number };",
		"",
		"export function satisfiesOnly(value: Config): Config {",
		"\treturn value satisfies Config;",
		"}",
		"",
		"export function satisfiesThenCast(value: Config): Config {",
		"\treturn value satisfies Config as Config;",
		"}",
	].join("\n"),
	"src/objects.ts": [
		"export function f(x: object): void {",
		"\tvoid x;",
		"}",
		"",
		"export function cache(): WeakMap<object, string> {",
		"\treturn new WeakMap<object, string>();",
		"}",
	].join("\n"),
	"src/spaced.ts": ["export function spaced(value: unknown): string {", "\treturn (", "\t\tvalue", "\t) as unknown as string;", "}"].join(
		"\n",
	),
	"src/long.ts": ["export function long(alpha: unknown): string {", `\treturn ${LONG_CAST};`, "}"].join("\n"),
	"src/ordering.ts": [
		"export function nine(value: unknown): string {",
		"\tconst a = 1;",
		"\tconst b = a;",
		"\tconst c = b;",
		"\tconst d = c;",
		"\tconst e = d;",
		"\tconst f = e;",
		"\tconst g = f;",
		"\treturn value as unknown as string;",
		"}",
		"",
		"export function thirteen(value: unknown): number {",
		"\treturn value as unknown as number;",
		"}",
	].join("\n"),
};

type Context = { readonly root: string; readonly host: TsHost; readonly project: TsProject };

let context: Context | undefined;

function opened(): Context {
	if (context === undefined) throw new Error("fixture is not open");
	return context;
}

async function castFailures(...files: readonly string[]): Promise<GateFailure[]> {
	const current = opened();
	return checkChainedCasts({
		root: current.root,
		production: files.map((file) => path.join(current.root, "src", file)),
		project: current.project,
	});
}

function castTexts(failures: readonly GateFailure[]): string[] {
	return failures.map((failure) => {
		if (failure.kind !== "unmarked-chained-cast") throw new Error(`unexpected failure kind ${failure.kind}`);
		return `${failure.file}:${failure.line} ${failure.text}`;
	});
}

function onlyCastText(failures: readonly GateFailure[]): string {
	const [failure] = failures;
	if (failure === undefined || failure.kind !== "unmarked-chained-cast") throw new Error("expected one chained cast failure");
	return failure.text;
}

beforeAll(async () => {
	const root = await mkdtemp(path.join(tmpdir(), "omomp-shared-casts-"));
	await mkdir(path.join(root, "src"), { recursive: true });
	await writeFile(
		path.join(root, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { target: "esnext", module: "preserve", moduleResolution: "bundler", strict: true, noEmit: true },
		}),
	);
	const names = Object.keys(FILES);
	await Promise.all(names.map((name) => writeFile(path.join(root, name), FILES[name] ?? "")));
	const host = openTsHost(root);
	const project = await host.open(names.map((name) => path.join(root, name)));
	context = { root, host, project };
});

afterAll(async () => {
	const current = context;
	context = undefined;
	if (current === undefined) return;
	await current.host.close();
	await rm(current.root, { recursive: true, force: true });
});

describe("checkChainedCasts", () => {
	test("reports an unmarked chain at the cast start line", async () => {
		expect(await castFailures("unmarked.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/unmarked.ts", line: 2, text: "value as unknown as string" },
		]);
	});

	test("reports a parenthesized chain once, at the outermost cast", async () => {
		expect(await castFailures("parenthesized.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/parenthesized.ts", line: 2, text: "(value as unknown) as string" },
		]);
	});

	test("reports an angle-bracket chain at the outermost assertion", async () => {
		expect(await castFailures("angle.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/angle.ts", line: 2, text: "<string><unknown>value" },
		]);
	});

	test("reports a mixed angle-bracket chain at the outermost assertion", async () => {
		expect(await castFailures("mixed.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/mixed.ts", line: 2, text: "<string>(value as unknown)" },
		]);
	});

	test("reports a three-link chain once", async () => {
		expect(await castFailures("triple.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/triple.ts", line: 2, text: "value as unknown as number as unknown as string" },
		]);
	});

	test("reports independent chains in one expression separately", async () => {
		expect(await castFailures("separate.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/separate.ts", line: 2, text: "(value as unknown) as string" },
			{ kind: "unmarked-chained-cast", file: "src/separate.ts", line: 2, text: "other as unknown as number" },
		]);
	});

	test("accepts the marker on the line above the cast", async () => {
		expect(await castFailures("marked-above.ts")).toEqual([]);
	});

	test("accepts a trailing marker on the cast start line", async () => {
		expect(await castFailures("marked-trailing.ts")).toEqual([]);
	});

	test("accepts the marker above the first line of a multi-line statement", async () => {
		expect(await castFailures("marked-statement.ts")).toEqual([]);
	});

	test("accepts a marker without a space after the comment slashes", async () => {
		expect(await castFailures("tight-marker.ts")).toEqual([]);
	});

	test("rejects an empty reason", async () => {
		expect(await castFailures("empty-reason.ts", "padded-reason.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/empty-reason.ts", line: 3, text: "value as unknown as string" },
			{ kind: "unmarked-chained-cast", file: "src/padded-reason.ts", line: 3, text: "value as unknown as string" },
		]);
	});

	test("rejects a marker two lines above the cast", async () => {
		expect(await castFailures("distant.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/distant.ts", line: 5, text: "value as unknown as string" },
		]);
	});

	test("rejects a marker that is only template text", async () => {
		expect(await castFailures("template.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/template.ts", line: 4, text: "value as unknown as string" },
		]);
	});

	test("takes a class member, not the class, as the statement above which a marker counts", async () => {
		expect(await castFailures("class-blessing.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/class-blessing.ts", line: 3, text: "(input as unknown) as string" },
		]);
	});

	test("accepts a single cast", async () => {
		expect(await castFailures("single-as.ts")).toEqual([]);
	});

	test("treats satisfies as not a cast", async () => {
		expect(await castFailures("satisfies.ts")).toEqual([]);
	});

	test("ignores object parameters and WeakMap type arguments", async () => {
		expect(await castFailures("objects.ts")).toEqual([]);
	});

	test("collapses whitespace runs in the reported text", async () => {
		expect(await castFailures("spaced.ts")).toEqual([
			{ kind: "unmarked-chained-cast", file: "src/spaced.ts", line: 2, text: "( value ) as unknown as string" },
		]);
	});

	test("cuts the reported text at 120 characters without trimming the cut", async () => {
		const failures = await castFailures("long.ts");
		expect(failures).toEqual([{ kind: "unmarked-chained-cast", file: "src/long.ts", line: 2, text: LONG_CAST.slice(0, 120) }]);
		expect(onlyCastText(failures)).toHaveLength(120);
		expect(onlyCastText(failures).endsWith(" ")).toBe(true);
	});

	test("sorts by file then numeric line", async () => {
		const failures = await castFailures("unmarked.ts", "ordering.ts", "parenthesized.ts");
		expect(castTexts(failures)).toEqual([
			"src/ordering.ts:9 value as unknown as string",
			"src/ordering.ts:13 value as unknown as number",
			"src/parenthesized.ts:2 (value as unknown) as string",
			"src/unmarked.ts:2 value as unknown as string",
		]);
	});

	test("inspects only the files listed as production", async () => {
		expect(await castFailures("parenthesized.ts")).toHaveLength(1);
		expect(await castFailures()).toEqual([]);
	});
});
