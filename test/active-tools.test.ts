import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolInfo } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { applyActiveTools, canonicalToolOrder } from "../src/active-tools.ts";

const NO_PARAMS = z.object({});

function tool(name: string, source: string): ToolInfo {
	return {
		name,
		description: `test tool ${name}`,
		parameters: NO_PARAMS,
		sourceInfo: { path: `<${source}:${name}>`, source, scope: "temporary", origin: "top-level" },
	};
}

describe("canonicalToolOrder", () => {
	test("requested builtins come first in registry order; every other requested name follows, code-point sorted and deduplicated", () => {
		const registry = [
			tool("read", "builtin"),
			tool("zeta", "extension"),
			tool("bash", "builtin"),
			tool("alpha", "extension"),
			tool("write", "builtin"),
			tool("mcp__srv_tool", "mcp"),
		];
		expect(canonicalToolOrder(registry, ["zeta", "unknown", "write", "alpha", "read", "mcp__srv_tool", "alpha"])).toEqual([
			"read",
			"write",
			"alpha",
			"mcp__srv_tool",
			"unknown",
			"zeta",
		]);
	});

	test("the non-builtin tail sorts by code point, not UTF-16 code unit", () => {
		const registry = [tool("read", "builtin")];
		expect(canonicalToolOrder(registry, ["\u{10000}", "～", "￿", "\u{1F600}"])).toEqual(["～", "￿", "\u{10000}", "\u{1F600}"]);
	});

	test("permutations and duplicates of one set give identical output", () => {
		const registry = [tool("read", "builtin"), tool("bash", "builtin"), tool("zed", "extension"), tool("alpha", "extension")];
		const names = ["zed", "read", "beta", "bash", "alpha"];
		const expected = canonicalToolOrder(registry, names);
		const reversed = canonicalToolOrder(registry, names.toReversed());
		expect(reversed).toEqual(expected);
		const duplicated = canonicalToolOrder(registry, [...names, "bash", "zed", "beta", ...names]);
		expect(duplicated).toEqual(expected);
		const rotated = names.slice(2).concat(names.slice(0, 2));
		expect(canonicalToolOrder(registry, rotated)).toEqual(expected);
	});

	test("a builtin in the registry that was not requested is not added", () => {
		const registry = [tool("read", "builtin"), tool("bash", "builtin")];
		expect(canonicalToolOrder(registry, ["zed"])).toEqual(["zed"]);
	});

	test("accepts any iterable of names", () => {
		const registry = [tool("read", "builtin")];
		function* names() {
			yield "zed";
			yield "read";
		}
		expect(canonicalToolOrder(registry, names())).toEqual(["read", "zed"]);
	});
});

describe("applyActiveTools", () => {
	test("calls setActiveTools exactly once with the canonical order", async () => {
		const calls: string[][] = [];
		const registry = [tool("read", "builtin"), tool("bash", "builtin"), tool("zed", "extension")];
		const pi: Pick<ExtensionAPI, "getAllTools" | "setActiveTools"> = {
			getAllTools: () => registry,
			setActiveTools: (names: string[]) => {
				calls.push([...names]);
				return Promise.resolve();
			},
		};
		await applyActiveTools(pi, ["zed", "bash", "read", "zed"]);
		expect(calls).toEqual([["read", "bash", "zed"]]);
	});

	test("an empty request still writes the set once", async () => {
		const calls: string[][] = [];
		const pi: Pick<ExtensionAPI, "getAllTools" | "setActiveTools"> = {
			getAllTools: () => [tool("read", "builtin")],
			setActiveTools: (names: string[]) => {
				calls.push([...names]);
				return Promise.resolve();
			},
		};
		await applyActiveTools(pi, []);
		expect(calls).toEqual([[]]);
	});
});
