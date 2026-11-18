import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	checkDeclaration,
	compareCopies,
	copyPlans,
	parseDeclaration,
	readDeclaration,
	relativeImports,
	sourceFiles,
} from "../lib/consumer.ts";

const SRC = path.join(import.meta.dir, "..", "src");
const scratch = mkdtempSync(path.join(tmpdir(), "omomp-shared-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(name: string, files: Record<string, string>): string {
	const dir = path.join(scratch, name);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		writeFileSync(path.join(dir, rel), text);
	}
	return dir;
}

describe("parseDeclaration", () => {
	test("accepts directory and a distinct file list", () => {
		expect(parseDeclaration(`{"directory":"src/shared","files":["a.ts","b.json"]}`)).toEqual({
			ok: true,
			declaration: { directory: "src/shared", files: ["a.ts", "b.json"] },
		});
	});
	test.each([
		["{", "not valid JSON"],
		[`["a.ts"]`, "must be a JSON object"],
		[`{"files":["a.ts"]}`, `missing field "directory"`],
		[`{"directory":"x"}`, `missing field "files"`],
		[`{"directory":"x","files":[]}`, "non-empty array"],
		[`{"directory":"x","files":["a.ts","a.ts"]}`, "twice"],
		[`{"directory":"x","files":["a.ts"],"target":"y"}`, `unknown field "target"`],
	])("rejects %s", (text, reason) => {
		const r = parseDeclaration(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.problems.join("\n")).toContain(reason);
	});
});

describe("checkDeclaration", () => {
	const src = fixture("src", {
		"a.ts": `import type { B } from "./b.ts";\nexport const a: B = 1;\n`,
		"b.ts": "export type B = number;\n",
		"c.ts": `export { a } from "./a.ts";\n`,
	});
	const root = fixture("consumer", {});
	test("an import closure that is fully declared passes", async () => {
		expect(await checkDeclaration(root, src, { directory: "lib/shared", files: ["a.ts", "b.ts"] })).toEqual([]);
	});
	test("a declared file importing an undeclared shared file is invalid, type-only imports included", async () => {
		expect(await checkDeclaration(root, src, { directory: "lib/shared", files: ["a.ts"] })).toEqual([
			`"a.ts" imports "b.ts", which is not declared`,
		]);
		expect(await checkDeclaration(root, src, { directory: "lib/shared", files: ["c.ts", "a.ts"] })).toEqual([
			`"a.ts" imports "b.ts", which is not declared`,
		]);
	});
	test("a directory outside the repository root is invalid", async () => {
		for (const directory of ["../x", "/tmp/x", "lib/../../x"]) {
			expect((await checkDeclaration(root, src, { directory, files: ["b.ts"] })).join("\n")).toContain("outside the repository root");
		}
	});
	test("a file that shared src/ does not have is invalid", async () => {
		expect(await checkDeclaration(root, src, { directory: "x", files: ["nope.ts"] })).toEqual([`"nope.ts" is not a file in shared src/`]);
	});
});

describe("compareCopies", () => {
	const src = fixture("cmp-src", { "a.ts": "export const a = 1;\n" });
	test("reports match, a one-byte difference, and a missing copy", async () => {
		const same = fixture("cmp-same", { "omomp-shared.json": `{"directory":"s","files":["a.ts"]}`, "s/a.ts": "export const a = 1;\n" });
		const diff = fixture("cmp-diff", { "omomp-shared.json": `{"directory":"s","files":["a.ts"]}`, "s/a.ts": "export const a = 2;\n" });
		const gone = fixture("cmp-gone", { "omomp-shared.json": `{"directory":"s","files":["a.ts"]}` });
		const kinds = [];
		for (const root of [same, diff, gone]) {
			const read = await readDeclaration(root, src);
			if (read.kind !== "declared") throw new Error(`${root}: ${read.kind}`);
			kinds.push((await compareCopies(copyPlans(root, src, read.declaration))).map((s) => s.kind));
		}
		expect(kinds).toEqual([["match"], ["differs"], ["missing"]]);
	});
	test("a repository without a declaration consumes nothing", async () => {
		expect(await readDeclaration(fixture("none", {}), src)).toEqual({ kind: "absent" });
	});
});

describe("shared src/ boundary", () => {
	test("public files import only src/ siblings, node builtins and host packages", async () => {
		const bad: string[] = [];
		for (const file of await sourceFiles(SRC)) {
			if (!file.endsWith(".ts")) continue;
			const code = await Bun.file(path.join(SRC, file)).text();
			for (const m of code.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)) {
				const spec = m[1] ?? m[2] ?? "";
				const allowed = spec.startsWith("./") || spec.startsWith("node:") || spec.startsWith("@oh-my-pi/") || spec === "zod";
				if (!allowed) bad.push(`${file}: ${spec}`);
			}
			for (const spec of relativeImports(code)) if (spec.startsWith("../")) bad.push(`${file}: ${spec}`);
		}
		expect(bad).toEqual([]);
	});
	test("verify, sync and test code stay out of src/", async () => {
		const outside = (await sourceFiles(SRC)).filter((f) => !/\.(ts|json)$/.test(f) || f.endsWith(".test.ts"));
		expect(outside).toEqual([]);
	});
});
