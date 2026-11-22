import { afterEach, beforeEach, expect, test } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { InternalResource, ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	clearToolTopics,
	getToolTopicInjections,
	listToolTopics,
	registerInternalScheme,
	registerToolTopics,
	resolveToolTopic,
} from "../src/internal-url.ts";

const OWNER_A = "tests/alpha";
const OWNER_B = "tests/beta";
const OWNER_BRAND = Symbol.for("omomp-shared/internal-url");

function schemeHandler(scheme: string, content: string): ProtocolHandler {
	return {
		scheme,
		spec: { backing: "virtual", selectors: "none", immutable: true },
		resolve(url): Promise<InternalResource> {
			return Promise.resolve({ url: url.href, content, contentType: "text/plain", size: content.length });
		},
	};
}

function schemeOrder(router: InternalUrlRouter): { builtin: string[]; other: string[] } {
	const builtin: string[] = [];
	const other: string[] = [];
	for (const scheme of router.specs().keys()) {
		if (router.isBuiltin(scheme)) builtin.push(scheme);
		else other.push(scheme);
	}
	return { builtin, other };
}

beforeEach(() => {
	clearToolTopics();
	InternalUrlRouter.resetForTests();
});

afterEach(() => {
	clearToolTopics();
	InternalUrlRouter.resetForTests();
});

test("registered schemes serve their URL, and non-built-in schemes sort by name after the built-ins", async () => {
	const router = new InternalUrlRouter();
	const builtinOrder = [...router.specs().keys()];
	const zeta = schemeHandler("zeta", "zeta body");
	const alpha = schemeHandler("alpha", "alpha body");
	expect(registerInternalScheme(router, OWNER_A, zeta).kind).toBe("registered");
	expect(registerInternalScheme(router, OWNER_A, alpha).kind).toBe("registered");
	const order = schemeOrder(router);
	expect(order.builtin).toEqual(builtinOrder);
	expect(order.other).toEqual(["alpha", "zeta"]);
	expect(router.getHandler("alpha")).toBe(alpha);
	expect(router.getHandler("zeta")).toBe(zeta);
	const resource = await router.resolve("alpha://x");
	expect(resource?.content).toBe("alpha body");
});

test("a built-in scheme is refused with the reason and keeps its handler", () => {
	const router = new InternalUrlRouter();
	const original = router.getHandler("skill");
	const hijack = schemeHandler("skill", "hijack");
	const result = registerInternalScheme(router, OWNER_A, hijack);
	expect(result).toEqual({ kind: "builtin", reason: "omp owns skill://" });
	expect(router.getHandler("skill")).toBe(original);
	expect(Reflect.get(hijack, OWNER_BRAND)).toBeUndefined();
});

test("a scheme held by a handler without an owner brand is refused", () => {
	const router = new InternalUrlRouter();
	const foreign = schemeHandler("foreign", "foreign body");
	router.register(foreign);
	const hijack = schemeHandler("foreign", "hijack");
	const result = registerInternalScheme(router, OWNER_A, hijack);
	expect(result).toEqual({ kind: "held", holder: { kind: "unbranded" }, reason: "a handler with no owner already holds foreign://" });
	expect(router.getHandler("foreign")).toBe(foreign);
	expect(Reflect.get(hijack, OWNER_BRAND)).toBeUndefined();
});

test("another owner is refused with the holding owner; the same owner replaces its handler", async () => {
	const router = new InternalUrlRouter();
	const first = schemeHandler("owned", "first body");
	expect(registerInternalScheme(router, OWNER_A, first).kind).toBe("registered");
	const hijack = schemeHandler("owned", "hijack");
	const result = registerInternalScheme(router, OWNER_B, hijack);
	expect(result).toEqual({ kind: "held", holder: { kind: "owner", id: OWNER_A }, reason: `${OWNER_A} already holds owned://` });
	expect(router.getHandler("owned")).toBe(first);
	expect(Reflect.get(hijack, OWNER_BRAND)).toBeUndefined();
	const replacement = schemeHandler("owned", "second body");
	expect(registerInternalScheme(router, OWNER_A, replacement).kind).toBe("registered");
	expect(router.getHandler("owned")).toBe(replacement);
	const resource = await router.resolve("owned://x");
	expect(resource?.content).toBe("second body");
});

test("ownership is recognized across two separately imported module instances", async () => {
	const secondInstance = "../src/internal-url.ts?v=2";
	const copyB: { registerInternalScheme: typeof registerInternalScheme } = await import(secondInstance);
	expect(copyB.registerInternalScheme).not.toBe(registerInternalScheme);
	const router = new InternalUrlRouter();
	expect(registerInternalScheme(router, OWNER_A, schemeHandler("shared", "first body")).kind).toBe("registered");
	expect(copyB.registerInternalScheme(router, OWNER_B, schemeHandler("shared", "hijack"))).toEqual({
		kind: "held",
		holder: { kind: "owner", id: OWNER_A },
		reason: `${OWNER_A} already holds shared://`,
	});
	const replacement = schemeHandler("shared", "second body");
	expect(copyB.registerInternalScheme(router, OWNER_A, replacement).kind).toBe("registered");
	expect(router.getHandler("shared")).toBe(replacement);
});

test("a frozen handler throws instead of registering unbranded", () => {
	const router = new InternalUrlRouter();
	const frozen = Object.freeze(schemeHandler("frozen", "body"));
	expect(() => registerInternalScheme(router, OWNER_A, frozen)).toThrow(TypeError);
	expect(router.getHandler("frozen")).toBeUndefined();
});

test("registerToolTopics registers tool:// handler spec, promptDoc, and multiplexes across module copies", async () => {
	const secondInstance = "../src/internal-url.ts?v=3";
	const copyB: {
		registerToolTopics: typeof registerToolTopics;
		listToolTopics: typeof listToolTopics;
		resolveToolTopic: typeof resolveToolTopic;
	} = await import(secondInstance);
	expect(copyB.registerToolTopics).not.toBe(registerToolTopics);

	let lang = "en";
	registerToolTopics("omp-config/tool-topics", [
		{
			tool: "read",
			topic: "json",
			title: "JSON queries",
			when: "reading JSON with jq",
			body: "Use `jq` selector.",
		},
		{
			tool: "read",
			topic: "failures",
			title: "Read failures",
			when: "read returns an error",
			body: "Check file path.",
			hiddenFromIndex: true,
			inject: [{ onError: true }],
		},
	]);
	copyB.registerToolTopics("omp-ask-more", [
		{
			tool: "ask",
			topic: "routing",
			title: "Routing answers",
			when: "framing multi-choice questions",
			body: () => `lang=${lang}`,
		},
	]);

	const router = InternalUrlRouter.instance();
	const handler = router.getHandler("tool");
	expect(handler).toBeDefined();
	expect(handler?.spec).toEqual({
		backing: "virtual",
		selectors: "lines",
		immutable: true,
		compactTranscript: true,
	});
	expect(
		handler?.promptDoc?.({
			skillUriAccess: true,
			ruleCount: 0,
			securityEnabled: false,
			settingsApproval: false,
			outReplies: false,
			subagent: false,
		}),
	).toBe("`tool://` / `tool://<tool>` / `tool://<tool>/<topic>` — On-demand tool topic docs and usage guides.");

	expect(listToolTopics().map((doc) => `${doc.tool}/${doc.topic}`)).toEqual(["ask/routing", "read/json"]);
	expect(listToolTopics(undefined, { includeHidden: true }).map((doc) => `${doc.tool}/${doc.topic}`)).toEqual([
		"ask/routing",
		"read/failures",
		"read/json",
	]);
	expect(copyB.listToolTopics("read").map((doc) => doc.topic)).toEqual(["json"]);

	lang = "zh";
	expect(resolveToolTopic("ask", "routing")?.content).toBe("lang=zh");
	expect(resolveToolTopic("read", "missing")).toBeUndefined();
});

test("registerToolTopics overwrites by owner and clearToolTopics clears owner or all", () => {
	registerToolTopics("plugin-a", [
		{ tool: "alpha", topic: "one", title: "One", when: "first", body: "body 1" },
		{ tool: "alpha", topic: "two", title: "Two", when: "second", body: "body 2" },
	]);
	registerToolTopics("plugin-b", [{ tool: "beta", topic: "only", title: "Only", when: "always", body: "beta body" }]);

	registerToolTopics("plugin-a", [{ tool: "alpha", topic: "three", title: "Three", when: "third", body: "body 3" }]);
	expect(listToolTopics().map((doc) => `${doc.tool}/${doc.topic}`)).toEqual(["alpha/three", "beta/only"]);

	clearToolTopics("plugin-a");
	expect(listToolTopics().map((doc) => `${doc.tool}/${doc.topic}`)).toEqual(["beta/only"]);

	clearToolTopics();
	expect(listToolTopics()).toEqual([]);
});

test("getToolTopicInjections returns only docs with non-empty inject rules including hidden docs", () => {
	registerToolTopics("omp-config", [
		{ tool: "read", topic: "json", title: "JSON", when: "jq", body: "jq" },
		{ tool: "read", topic: "empty-rule", title: "Empty", when: "never", body: "none", inject: [] },
		{
			tool: "edit",
			topic: "hashline-recovery",
			title: "Hashline recovery",
			when: "hashline mismatch",
			body: "Re-read file.",
			hiddenFromIndex: true,
			inject: [{ onError: true, resultPattern: "hashline" }],
		},
		{
			tool: "bash",
			topic: "urls",
			title: "Bash URLs",
			when: "using internal URLs",
			body: "Use scheme://",
			inject: [{ param: "command", pattern: "://" }],
		},
	]);

	expect(getToolTopicInjections().map((doc) => `${doc.tool}/${doc.topic}`)).toEqual(["bash/urls", "edit/hashline-recovery"]);
});

test("tool:// resolve handles tool://, tool://<tool>, tool://<tool>/<topic>, hidden topics, and ToolError misses", async () => {
	registerToolTopics("omp-config", [
		{ tool: "read", topic: "json", title: "JSON", when: "querying JSON", body: "# JSON\nUse jq." },
		{
			tool: "read",
			topic: "failures",
			title: "Failures",
			when: "read errors",
			body: "# Failures\nRetry.",
			hiddenFromIndex: true,
			inject: [{ onError: true }],
		},
		{
			tool: "edit",
			topic: "recovery",
			title: "Recovery",
			when: "edit fails",
			body: "# Recovery\nRe-read.",
			hiddenFromIndex: true,
			inject: [{ onError: true }],
		},
	]);

	const router = InternalUrlRouter.instance();

	const root = await router.resolve("tool://");
	expect(root.contentType).toBe("text/markdown");
	expect(root.content).toContain("## read");
	expect(root.content).toContain("tool://read/json — JSON (when: querying JSON)");
	expect(root.content).not.toContain("tool://read/failures");
	expect(root.content).toContain("## edit");
	expect(root.content).toContain("tool://edit/recovery — Recovery (when: edit fails) [hidden]");

	const readIndex = await router.resolve("tool://read");
	expect(readIndex.content).toContain("tool://read/json — JSON (when: querying JSON)");
	expect(readIndex.content).toContain("tool://read/failures — Failures (when: read errors) [hidden]");

	const hiddenDoc = await router.resolve("tool://read/failures");
	expect(hiddenDoc.content).toBe("# Failures\nRetry.");

	await expect(router.resolve("tool://read/unknown")).rejects.toThrow(ToolError);
	await expect(router.resolve("tool://read/unknown")).rejects.toThrow("Available: failures, json.");
	await expect(router.resolve("tool://missing")).rejects.toThrow(ToolError);
	await expect(router.resolve("tool://missing")).rejects.toThrow("Tools with topics: edit, read.");
	await expect(router.resolve("tool://read/json/extra")).rejects.toThrow(ToolError);
	await expect(router.resolve("tool://read?x=1")).rejects.toThrow(ToolError);

	clearToolTopics();
	const emptyRoot = await router.resolve("tool://");
	expect(emptyRoot.content).toContain("No tool topics registered.");
});

test("tool:// complete and enumerate support autocomplete, grep, and glob", async () => {
	registerToolTopics("omp-sessions", [
		{ tool: "session_query", topic: "sql", title: "DuckDB SQL", when: "querying sessions", body: "SELECT * FROM events" },
	]);
	registerToolTopics("omp-actual-terminal", [
		{ tool: "exec_command", topic: "pty-io", title: "PTY I/O", when: "interactive commands", body: "Use write_stdin" },
		{
			tool: "exec_command",
			topic: "pty-lifecycle",
			title: "PTY lifecycle",
			when: "reclaim or exit",
			body: "Use term://",
			hiddenFromIndex: true,
		},
	]);

	const router = InternalUrlRouter.instance();
	const allCompletions = await router.complete("tool", "");
	expect(allCompletions?.map((c) => c.value)).toEqual([
		"exec_command",
		"exec_command/pty-io",
		"exec_command/pty-lifecycle",
		"session_query",
		"session_query/sql",
	]);

	const filteredCompletions = await router.complete("tool", "exec_command/");
	expect(filteredCompletions?.map((c) => c.value)).toEqual(["exec_command/pty-io", "exec_command/pty-lifecycle"]);

	const allLeaves = await router.enumerate("tool://");
	expect(allLeaves).toEqual([
		{ url: "tool://exec_command/pty-io", content: "Use write_stdin" },
		{ url: "tool://exec_command/pty-lifecycle", content: "Use term://" },
		{ url: "tool://session_query/sql", content: "SELECT * FROM events" },
	]);

	const oneToolLeaves = await router.enumerate("tool://session_query");
	expect(oneToolLeaves).toEqual([{ url: "tool://session_query/sql", content: "SELECT * FROM events" }]);

	const singleLeaf = await router.enumerate("tool://exec_command/pty-io");
	expect(singleLeaf).toEqual([{ url: "tool://exec_command/pty-io", content: "Use write_stdin" }]);

	if (allLeaves) {
		for (const leaf of allLeaves) {
			const resolved = await router.resolve(leaf.url);
			expect(resolved.content).toBe(leaf.content);
		}
	}
});
