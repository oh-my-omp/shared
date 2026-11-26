import { describe, expect, test } from "bun:test";
import { dependencyProblems, hostPackages, type Manifest, parseManifest, shimProblems } from "../lib/deps.ts";
import { isProductionSource, toolEntryGateProblems } from "../lib/tool-entry-gate.ts";

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

describe("toolEntryGateProblems", () => {
	test("flags a direct registerTool(variable) with file and line", () => {
		const text = 'import { x } from "./x";\nexport default function entry(pi: P): void {\n\tpi.registerTool(TODO_TOOL_DEFINITION);\n}\n';
		const problems = toolEntryGateProblems("index.ts", text);
		expect(problems).toHaveLength(1);
		expect(problems[0]?.file).toBe("index.ts");
		expect(problems[0]?.line).toBe(3);
		expect(problems[0]?.construction).toBe("registerTool");
	});

	test("flags a bare destructured registerTool(definition)", () => {
		const text = "const { registerTool } = pi;\nregisterTool(definition);\n";
		expect(toolEntryGateProblems("index.ts", text).map((p) => p.line)).toEqual([2]);
	});

	test("passes registerTool(omompTool({...})) across multiple lines", () => {
		const text = [
			"export default function entry(pi: P): void {",
			"\tpi.registerTool(",
			"\t\tomompTool({",
			'\t\t\tname: "todo",',
			"\t\t\tparameters,",
			"\t\t\tasync execute() {},",
			"\t\t}),",
			"\t);",
			"}",
		].join("\n");
		expect(toolEntryGateProblems("index.ts", text)).toEqual([]);
	});

	test("flags extra tokens after the omompTool call", () => {
		const text = "pi.registerTool(omompTool(def) as Tool);\n";
		expect(toolEntryGateProblems("index.ts", text)).toHaveLength(1);
	});

	test("flags customTools: [omompTool(a), b] for the bare element", () => {
		const text = "const options = { customTools: [omompTool(a), b] };\n";
		const problems = toolEntryGateProblems("seat.ts", text);
		expect(problems).toHaveLength(1);
		expect(problems[0]?.construction).toBe("customTools");
		expect(problems[0]?.line).toBe(1);
	});

	test("passes customTools: [omompTool(a), omompTool(b)]", () => {
		const text = "const options = {\n\tcustomTools: [omompTool(a), omompTool(b)],\n\tmodel,\n};\n";
		expect(toolEntryGateProblems("seat.ts", text)).toEqual([]);
	});

	test("passes an empty customTools array literal", () => {
		expect(toolEntryGateProblems("seat.ts", "const o = { customTools: [] };\n")).toEqual([]);
	});

	test("flags customTools: tools (non-literal)", () => {
		const text = "const options = { customTools: seatTools };\n";
		expect(toolEntryGateProblems("seat.ts", text)).toHaveLength(1);
	});

	test("flags a spread element in customTools", () => {
		const text = "const options = { customTools: [...seatTools] };\n";
		expect(toolEntryGateProblems("seat.ts", text)).toHaveLength(1);
	});

	test("flags customTools shorthand handed to the host", () => {
		const problems = toolEntryGateProblems("seat.ts", "createAgentSession({ model, customTools });\n");
		expect(problems).toHaveLength(1);
		expect(problems[0]?.construction).toBe("customTools");
	});

	test("checks the value assigned to a customTools member", () => {
		expect(toolEntryGateProblems("seat.ts", "opts.customTools = [bare];\n")).toHaveLength(1);
		expect(toolEntryGateProblems("seat.ts", "opts.customTools = seatTools;\n")).toHaveLength(1);
		expect(toolEntryGateProblems("seat.ts", "opts.customTools = [omompTool(a)];\n")).toEqual([]);
	});

	test("ignores customTools reads, comparisons, destructuring and parameter types", () => {
		const text = [
			"const { customTools } = options;",
			"const { customTools: tools } = options;",
			"function f({ customTools }: Options) {}",
			"function g(opts: { customTools: Tool[] }) {}",
			"const h = ({ customTools }) => customTools;",
			"for (const { customTools } of list) {}",
			"if (opts.customTools === undefined) {}",
			"use(opts.customTools);",
		].join("\n");
		expect(toolEntryGateProblems("seat.ts", text)).toEqual([]);
	});

	test("ignores commented-out and string occurrences", () => {
		const text = [
			"// pi.registerTool(definition);",
			"/* pi.registerTool(other);",
			"   const o = { customTools: defs }; */",
			'const doc = "pi.registerTool(definition)";',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture input for the scanner, not a template mistake
			"const tpl = `registerTool(${1 + 1} x)`;",
			"const help = 'customTools: tools';",
			"pi.registerTool(omompTool(def));",
		].join("\n");
		expect(toolEntryGateProblems("index.ts", text)).toEqual([]);
	});

	test("ignores regex literals containing the trigger words", () => {
		const text = "const re = /registerTool\\(x\\)/;\npi.registerTool(omompTool(def));\n";
		expect(toolEntryGateProblems("index.ts", text)).toEqual([]);
	});

	test("ignores test and spec files and test directories", () => {
		const text = "pi.registerTool(definition);\n";
		for (const file of [
			"index.test.ts",
			"src/tool.test.tsx",
			"src/acceptance.spec.ts",
			"test/index.ts",
			"tests/index.ts",
			"src/test/helper.ts",
			"__tests__/index.ts",
			"src/index.d.ts",
			"node_modules/pkg/index.ts",
		]) {
			expect(toolEntryGateProblems(file, text)).toEqual([]);
		}
		expect(isProductionSource("src/ports/host.ts")).toBe(true);
		expect(isProductionSource("index.ts")).toBe(true);
	});

	test("ignores an object method declaration registerTool(tool) {}", () => {
		const text = [
			"const fake = {",
			"\tregisterTool(tool) {",
			"\t\tthis.tools.push(tool);",
			"\t},",
			"};",
			"class Host {",
			"\tregisterTool(tool) {}",
			"}",
			"pi.registerTool(omompTool(def));",
		].join("\n");
		expect(toolEntryGateProblems("index.ts", text)).toEqual([]);
	});

	test("ignores type-level registerTool members", () => {
		const text = [
			"interface FakeHost {",
			"\tregisterTool(tool: Tool): void;",
			"\tcustomTools: [Tool, Tool];",
			"}",
			"type Hostish = {",
			"\tregisterTool(tool: Tool): void;",
			"\tcustomTools: Tool[];",
			"};",
			'declare module "x" {',
			"\tfunction registerTool(definition: Tool): void;",
			"}",
			"pi.registerTool(omompTool(def));",
		].join("\n");
		expect(toolEntryGateProblems("index.ts", text)).toEqual([]);
	});

	test("ignores a customTools property access and unrelated names", () => {
		const text = "pi.registerToolTopics(docs);\nconst n = session.customTools.length;\npi.registerTool(omompTool(def));\n";
		expect(toolEntryGateProblems("index.ts", text)).toEqual([]);
	});

	test("finds calls nested inside class methods and closures", () => {
		const text = "class Seat {\n\tactivate(pi: P): void {\n\t\tpi.registerTool(this.definition);\n\t}\n}\n";
		expect(toolEntryGateProblems("seat.ts", text).map((p) => p.line)).toEqual([3]);
	});

	test("passes a registerTool call with type arguments over omompTool", () => {
		const text = "pi.registerTool<Def>(omompTool(def));\n";
		expect(toolEntryGateProblems("index.ts", text)).toEqual([]);
	});
});
