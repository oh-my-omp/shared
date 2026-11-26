import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Shape } from "../lib/gate/model.ts";
import { collectSources, deriveShape } from "../lib/gate/scope.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "omomp-gate-scope-"));
let serial = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(tree: Record<string, string | undefined>): string {
	const root = mkdtempSync(path.join(scratch, `repo-${serial++}-`));
	for (const [relative, content] of Object.entries(tree)) {
		const target = path.join(root, relative);
		if (content === undefined) {
			mkdirSync(target, { recursive: true });
			continue;
		}
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return root;
}

function exemptReason(shape: Shape): string {
	if (shape.kind !== "exempt") throw new Error(`expected an exempt shape, got ${shape.kind}`);
	return shape.reason;
}

function manifest(value: unknown): string {
	return JSON.stringify(value);
}

describe("deriveShape", () => {
	test("recognizes this repository as shared-source", async () => {
		expect(await deriveShape(path.resolve(import.meta.dir, ".."))).toEqual({ kind: "shared-source" });
	});

	test("exempts a root without package.json", async () => {
		const shape = await deriveShape(fixture({ "README.md": "plain\n" }));
		expect(exemptReason(shape)).toContain("no package.json");
	});

	test("exempts unparseable package.json", async () => {
		const shape = await deriveShape(fixture({ "package.json": "{ not json" }));
		expect(exemptReason(shape)).toContain("not valid JSON");
	});

	test("exempts non-object package.json", async () => {
		for (const value of ["[]", '"omomp-shared"', "null", "42"]) {
			const shape = await deriveShape(fixture({ "package.json": value }));
			expect(exemptReason(shape)).toContain("not a JSON object");
		}
	});

	test("prefers shared-source over omp.extensions", async () => {
		const root = fixture({
			"package.json": manifest({
				name: "omomp-shared",
				omp: { extensions: ["./src/index.ts"] },
			}),
			"src/index.ts": "export {};\n",
		});
		expect(await deriveShape(root)).toEqual({ kind: "shared-source" });
	});

	test("omomp-shared without src falls through to extensions", async () => {
		const withExtensions = fixture({
			"package.json": manifest({ name: "omomp-shared", omp: { extensions: ["./agent/extensions/a.ts"] } }),
		});
		expect(await deriveShape(withExtensions)).toEqual({ kind: "plugin-single", entries: ["agent/extensions/a.ts"] });
		const withoutExtensions = fixture({ "package.json": manifest({ name: "omomp-shared" }) });
		expect(exemptReason(await deriveShape(withoutExtensions))).toContain("declares no omp.extensions");
	});

	test("recognizes a config bundle and prefers it over omp.extensions", async () => {
		const bundle = fixture({
			"package.json": manifest({ name: "omp-config" }),
			"agent/extensions/_shared/package.json": manifest({ name: "shared" }),
			"agent/extensions/a/index.ts": "export {};\n",
		});
		expect(await deriveShape(bundle)).toEqual({ kind: "config-bundle" });
		const bundleWithExtensions = fixture({
			"package.json": manifest({ omp: { extensions: ["./agent/extensions/a/index.ts"] } }),
			"agent/extensions/_shared/package.json": manifest({ name: "shared" }),
		});
		expect(await deriveShape(bundleWithExtensions)).toEqual({ kind: "config-bundle" });
	});

	test("agent/extensions without _shared/package.json is not a config bundle", async () => {
		const root = fixture({
			"package.json": manifest({ omp: { extensions: ["./agent/extensions/a/index.ts"] } }),
			"agent/extensions/a/index.ts": "export {};\n",
		});
		expect(await deriveShape(root)).toEqual({ kind: "plugin-single", entries: ["agent/extensions/a/index.ts"] });
	});

	test("normalizes a single extension entry", async () => {
		const root = fixture({
			"package.json": manifest({ omp: { extensions: ["./agent/extensions/./a/../a/index.ts"] } }),
		});
		expect(await deriveShape(root)).toEqual({ kind: "plugin-single", entries: ["agent/extensions/a/index.ts"] });
	});

	test("keeps multi-extension order and normalizes each entry", async () => {
		const root = fixture({
			"package.json": manifest({
				omp: { extensions: ["./agent/extensions/second/index.ts", "./agent/extensions/first/index.ts"] },
			}),
		});
		expect(await deriveShape(root)).toEqual({
			kind: "plugin-multi",
			entries: ["agent/extensions/second/index.ts", "agent/extensions/first/index.ts"],
		});
	});

	test("exempts malformed omp.extensions", async () => {
		const cases: Array<[unknown, string]> = [
			[{ omp: { extensions: "./agent/extensions/a/index.ts" } }, "omp.extensions is not an array"],
			[{ omp: { extensions: [] } }, "omp.extensions is empty"],
			[{ omp: { extensions: [42] } }, "omp.extensions[0] is not a non-empty string"],
			[{ omp: { extensions: [""] } }, "omp.extensions[0] is not a non-empty string"],
			[{ omp: { extensions: ["./a.ts", false] } }, "omp.extensions[1] is not a non-empty string"],
		];
		for (const [value, expected] of cases) {
			const shape = await deriveShape(fixture({ "package.json": manifest(value) }));
			expect(exemptReason(shape)).toContain(expected);
		}
	});

	test("exempts manifests that declare nothing recognizable", async () => {
		const shape = await deriveShape(fixture({ "package.json": manifest({ name: "some-site", omp: { extensions: undefined } }) }));
		const reason = exemptReason(shape);
		expect(reason).toContain("declares no omp.extensions");
	});
});

describe("collectSources", () => {
	test("classifies sources and never walks excluded or dot directories", async () => {
		const root = fixture({
			"src/app.ts": "export {};\n",
			"src/comp.tsx": "export {};\n",
			"src/types.d.ts": "export {};\n",
			"src/mod.mts": "export {};\n",
			"src/mod.cts": "export {};\n",
			"src/note.md": "text\n",
			"src/foo.test.ts": "export {};\n",
			"src/foo.spec.ts": "export {};\n",
			"src/foo.test.jsx": "export {};\n",
			"src/extra.spec.tsx": "export {};\n",
			"src/extra_test.ts": "export {};\n",
			"src/nested/test/a.ts": "export {};\n",
			"test/a.ts": "export {};\n",
			"test/basic.test.ts": "export {};\n",
			"test/helper.js": "export {};\n",
			"tests/b.ts": "export {};\n",
			"tests/more_spec.mts": "export {};\n",
			"eval/c.ts": "export {};\n",
			"eval/readability_test.ts": "export {};\n",
			"bench/d.ts": "export {};\n",
			"demo/e.ts": "export {};\n",
			"research/f.ts": "export {};\n",
			"sandbox/g.ts": "export {};\n",
			"node_modules/dep/index.ts": "export {};\n",
			"pkg/node_modules/x.ts": "export {};\n",
			"dist/out.ts": "export {};\n",
			"pkg/dist/x.ts": "export {};\n",
			".hidden/y.ts": "export {};\n",
			"src/.cache/z.ts": "export {};\n",
		});
		const sources = await collectSources(root, { kind: "plugin-single", entries: ["src/app.ts"] });
		expect(sources.production).toEqual([
			"src/app.ts",
			"src/comp.tsx",
			"src/extra_test.ts",
			"src/mod.cts",
			"src/mod.mts",
			"src/types.d.ts",
		]);
		expect(sources.nonProduction).toEqual([
			"bench/d.ts",
			"demo/e.ts",
			"eval/c.ts",
			"eval/readability_test.ts",
			"research/f.ts",
			"sandbox/g.ts",
			"src/extra.spec.tsx",
			"src/foo.spec.ts",
			"src/foo.test.ts",
			"src/nested/test/a.ts",
			"test/a.ts",
			"test/basic.test.ts",
			"tests/b.ts",
			"tests/more_spec.mts",
		]);
		expect(sources.tests).toEqual([
			"eval/readability_test.ts",
			"src/extra.spec.tsx",
			"src/extra_test.ts",
			"src/foo.spec.ts",
			"src/foo.test.jsx",
			"src/foo.test.ts",
			"test/basic.test.ts",
			"tests/more_spec.mts",
		]);
	});

	test("limits config-bundle sources to the extension directories while discovering tests anywhere", async () => {
		const root = fixture({
			"agent/extensions/a/index.ts": "export {};\n",
			"agent/extensions/a/index.test.ts": "export {};\n",
			"agent/extensions/_shared/lib.ts": "export {};\n",
			"agent/extensions-last/b/index.ts": "export {};\n",
			"agent/other/y.ts": "export {};\n",
			"ci/x.ts": "export {};\n",
			"ci/x.test.ts": "export {};\n",
		});
		const bundle = await collectSources(root, { kind: "config-bundle" });
		expect(bundle.production).toEqual([
			"agent/extensions-last/b/index.ts",
			"agent/extensions/_shared/lib.ts",
			"agent/extensions/a/index.ts",
		]);
		expect(bundle.nonProduction).toEqual(["agent/extensions/a/index.test.ts"]);
		expect(bundle.tests).toEqual(["agent/extensions/a/index.test.ts", "ci/x.test.ts"]);
		const plugin = await collectSources(root, { kind: "plugin-single", entries: ["agent/extensions/a/index.ts"] });
		expect(plugin.production).toEqual([
			"agent/extensions-last/b/index.ts",
			"agent/extensions/_shared/lib.ts",
			"agent/extensions/a/index.ts",
			"agent/other/y.ts",
			"ci/x.ts",
		]);
	});

	test("yields an empty tests list for a repository without tests", async () => {
		const sources = await collectSources(fixture({ "src/app.ts": "export {};\n" }), { kind: "shared-source" });
		expect(sources).toEqual({ production: ["src/app.ts"], nonProduction: [], tests: [] });
	});

	test("does not follow symlinked directories", async () => {
		const root = fixture({ "src/app.ts": "export {};\n", "sibling/only.ts": "export {};\n" });
		symlinkSync(path.join(root, "sibling"), path.join(root, "linked"), "dir");
		const sources = await collectSources(root, { kind: "shared-source" });
		expect(sources).toEqual({ production: ["sibling/only.ts", "src/app.ts"], nonProduction: [], tests: [] });
	});
});
