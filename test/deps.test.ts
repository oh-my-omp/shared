import { describe, expect, test } from "bun:test";
import { dependencyProblems, hostPackages, type Manifest, parseManifest, shimProblems } from "../lib/deps.ts";

function manifest(value: object): Manifest {
	const parsed = parseManifest(JSON.stringify(value));
	if (!parsed.ok) throw new Error("fixture must parse");
	return parsed.manifest;
}

describe("dependencyProblems", () => {
	test("accepts latest, star peers and git specs without a commit", () => {
		const problems = dependencyProblems(
			manifest({
				dependencies: { "@oh-my-pi/omptype": "latest" },
				devDependencies: { "omp-unified-exec": "github:oh-my-omp/omp-unified-exec", other: "https://github.com/o/r.git#release" },
				peerDependencies: { "@oh-my-pi/pi-coding-agent": "*" },
			}),
		);
		expect(problems).toEqual([]);
	});

	test("rejects versions, ranges, commit refs and non-star peers", () => {
		const problems = dependencyProblems(
			manifest({
				dependencies: { a: "1.2.3", b: "^5.0.0" },
				devDependencies: { c: "github:o/r#0123abc", d: "git+https://x/r.git#semver:^1" },
				peerDependencies: { e: ">=0.99.1", f: "latest" },
			}),
		);
		expect(problems.map((p) => (p.kind === "pinned" ? `${p.section}.${p.name}` : p.kind))).toEqual([
			"dependencies.a",
			"dependencies.b",
			"devDependencies.c",
			"devDependencies.d",
			"peerDependencies.e",
			"peerDependencies.f",
		]);
	});

	test("rejects legacy pi and typebox packages even at latest", () => {
		const problems = dependencyProblems(
			manifest({
				devDependencies: {
					"@earendil-works/pi-tui": "latest",
					typebox: "latest",
					"@sinclair/typebox": "latest",
					"typebox-extra": "latest",
				},
				peerDependencies: { "@mariozechner/pi-ai": "*" },
			}),
		);
		expect(problems.filter((p) => p.kind === "legacy").map((p) => (p.kind === "legacy" ? p.name : ""))).toEqual([
			"@earendil-works/pi-tui",
			"typebox",
			"@sinclair/typebox",
			"@mariozechner/pi-ai",
		]);
		expect(problems).toHaveLength(4);
	});
});

test("parseManifest reports non-string specs", () => {
	const parsed = parseManifest(JSON.stringify({ devDependencies: { a: 1 } }));
	expect(parsed.ok).toBe(false);
});

test("hostPackages lists installed @oh-my-pi packages once, without peers", () => {
	expect(
		hostPackages(
			manifest({
				dependencies: { "@oh-my-pi/omptype": "latest" },
				devDependencies: { "@oh-my-pi/pi-tui": "latest", "@oh-my-pi/omptype": "latest", typescript: "latest" },
				peerDependencies: { "@oh-my-pi/pi-ai": "*" },
			}),
		),
	).toEqual(["@oh-my-pi/omptype", "@oh-my-pi/pi-tui"]);
});

test("shimProblems finds host module declarations by line", () => {
	const text = 'declare namespace Bun {}\ndeclare module \x22@oh-my-pi/pi-tui/tools\x22 {\n}\ndeclare module "other" {}\n';
	expect(shimProblems("a.d.ts", text)).toEqual([{ file: "a.d.ts", line: 2, module: "@oh-my-pi/pi-tui/tools" }]);
});
