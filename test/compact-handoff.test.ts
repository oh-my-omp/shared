import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage, CompactionPreparation, FileOperations } from "@oh-my-pi/pi-agent-core";
import type {
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	CompactionEntry,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
	SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import {
	COMPACT_HANDOFF_REVISION,
	COMPACT_REGISTRY_SYMBOL,
	COMPACTION_PROMPT,
	type CompactExtensionAPI,
	computeSafePostCompactInsertIndex,
	deferDuringCompaction,
	defineStatefulHarnessHandoff,
	defineStatelessNoiseGuard,
	enterCompactionBarrier,
	getSharedCompactCoordinator,
	isCompacting,
	normalizeFilePath,
	prunePreparationFileOpsInPlace,
	registerCompactHandoff,
	releaseCompactionBarrier,
	SharedCompactCoordinator,
} from "../src/compact-handoff.ts";

const REVISION_SHA256: Readonly<Record<number, string>> = {
	2: "77037984eead661df466ec7524524e33e54efc0fbdd74e830b42ac5c15663c3b",
};

type CompactHandoffModule = typeof import("../src/compact-handoff.ts");
type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const _assertRealExtensionApiAssignable: (pi: ExtensionAPI) => CompactExtensionAPI = (pi) => pi;
void _assertRealExtensionApiAssignable;

function createMockHostRunner() {
	const handlers = new Map<string, AnyHandler[]>();
	const sharedEvents = {};
	const warnings: string[] = [];

	const add = (name: string, fn: AnyHandler) => {
		const list = handlers.get(name) ?? [];
		list.push(fn);
		handlers.set(name, list);
	};

	const createPluginApi = (): CompactExtensionAPI =>
		({
			events: sharedEvents,
			logger: { warn: (msg: string) => warnings.push(msg) },
			on(event: string, handler: AnyHandler) {
				add(event, handler);
			},
		}) as unknown as CompactExtensionAPI;

	return {
		createPluginApi,
		warnings,
		count(event: string): number {
			return handlers.get(event)?.length ?? 0;
		},
		async emitAutoStart(event: AutoCompactionStartEvent, ctx: ExtensionContext) {
			for (const h of handlers.get("auto_compaction_start") ?? []) await h(event, ctx);
		},
		async emitBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
			for (const h of handlers.get("session_before_compact") ?? []) await h(event, ctx);
		},
		async emitCompacting(event: SessionCompactingEvent, ctx: ExtensionContext): Promise<SessionCompactingResult | undefined> {
			let result: SessionCompactingResult | undefined;
			for (const h of handlers.get("session.compacting") ?? []) {
				const r = (await h(event, ctx)) as SessionCompactingResult | undefined;
				if (r) result = r;
			}
			return result;
		},
		async emitCompact(event: SessionCompactEvent, ctx: ExtensionContext) {
			for (const h of handlers.get("session_compact") ?? []) await h(event, ctx);
		},
		async emitAutoEnd(event: AutoCompactionEndEvent, ctx: ExtensionContext) {
			for (const h of handlers.get("auto_compaction_end") ?? []) await h(event, ctx);
		},
		async emitAgentStart(event: AgentStartEvent, ctx: ExtensionContext) {
			for (const h of handlers.get("agent_start") ?? []) await h(event, ctx);
		},
		async emitBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult[]> {
			const out: BeforeAgentStartEventResult[] = [];
			for (const h of handlers.get("before_agent_start") ?? []) {
				const r = (await h(event, ctx)) as BeforeAgentStartEventResult | undefined;
				if (r) out.push(r);
			}
			return out;
		},
	};
}

function makeFileOps(read: string[], edited: string[] = [], written: string[] = []): FileOperations {
	return { read: new Set(read), edited: new Set(edited), written: new Set(written) };
}

function makePreparation(
	fileOps: FileOperations,
	messagesToSummarize: AgentMessage[] = [],
	previousSummary?: string,
): CompactionPreparation {
	return {
		firstKeptEntryId: "kept_1",
		messagesToSummarize,
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 450000,
		previousSummary,
		fileOps,
		settings: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 },
	} as unknown as CompactionPreparation;
}

function makeContext(entries: SessionEntry[], cwd = "/repo"): ExtensionContext {
	const leaf = entries[entries.length - 1];
	const byId = new Map(entries.map((e) => [e.id, e]));
	const sessionManager = {
		getEntries: () => [...entries],
		getLeafId: () => (leaf ? leaf.id : null),
		getEntry: (id: string) => byId.get(id),
	};
	return { cwd, sessionManager, model: undefined } as unknown as ExtensionContext;
}

beforeEach(() => {
	getSharedCompactCoordinator().resetForTest();
});

describe("compact-handoff", () => {
	test("multi-copy Symbol.for coordination unifies ?copy=1 and ?copy=2 into 1 handler and 1 prune pass", async () => {
		const copy1 = (await import(`../src/compact-handoff.ts?copy=1` as string)) as CompactHandoffModule;
		const copy2 = (await import(`../src/compact-handoff.ts?copy=2` as string)) as CompactHandoffModule;

		expect(copy1).not.toBe(copy2);
		expect(copy1.COMPACT_REGISTRY_SYMBOL).toBe(COMPACT_REGISTRY_SYMBOL);
		expect(copy1.getSharedCompactCoordinator()).toBe(copy2.getSharedCompactCoordinator());

		const runner = createMockHostRunner();
		const pi1 = runner.createPluginApi();
		const pi2 = runner.createPluginApi();

		copy1.registerCompactHandoff(
			pi1,
			copy1.defineStatefulHarnessHandoff<{ count: number }>({
				pluginId: "omp-todo-ng",
				captureState: () => ({ count: 4 }),
				renderCompactPromptClaim: (s) => `Todo tree (${s.count} open items)`,
				renderPostCompactInjection: () => ({ source: "omp-todo-ng/planning", delivery: "plugin-managed" }),
			}),
		);
		copy2.registerCompactContribution(
			pi2,
			copy2.defineStatefulHarnessHandoff<{ ptys: number }>({
				pluginId: "omp-actual-terminal",
				captureState: () => ({ ptys: 2 }),
				renderCompactPromptClaim: (s) => `PTY sessions (${s.ptys} live)`,
				renderPostCompactInjection: (s) => ({
					source: "omp-actual-terminal/sessions",
					delivery: "delta-stream",
					content: `ptys=${s.ptys}`,
				}),
			}),
		);
		// Idempotent overwrite by pluginId
		copy2.registerCompactHandoff(
			pi2,
			copy2.defineStatefulHarnessHandoff<{ ptys: number }>({
				pluginId: "omp-actual-terminal",
				captureState: () => ({ ptys: 3 }),
				renderCompactPromptClaim: (s) => `PTY sessions (${s.ptys} live)`,
				renderPostCompactInjection: (s) => ({
					source: "omp-actual-terminal/sessions",
					delivery: "delta-stream",
					content: `ptys=${s.ptys}`,
				}),
			}),
		);

		expect(runner.count("session_before_compact")).toBe(1);
		expect(runner.count("session.compacting")).toBe(1);
		expect(() =>
			getSharedCompactCoordinator().registerStrict(
				defineStatelessNoiseGuard({ pluginId: "omp-actual-terminal", renderNoiseGuardDirective: () => "dup" }),
			),
		).toThrow("Duplicate CompactContribution");

		const prep = makePreparation(makeFileOps(["/tmp/noise.log", "src/index.ts?q=.foo"]));
		const ctx = makeContext([]);
		await runner.emitBeforeCompact(
			{ type: "session_before_compact", preparation: prep, branchEntries: [], signal: new AbortController().signal },
			ctx,
		);
		await runner.emitBeforeCompact(
			{ type: "session_before_compact", preparation: prep, branchEntries: [], signal: new AbortController().signal },
			ctx,
		);
		expect(getSharedCompactCoordinator().getFileOpsPruneCount(ctx.sessionManager)).toBe(1);

		const res = await runner.emitCompacting({ type: "session.compacting", sessionId: "s1", messages: [] }, ctx);
		const joined = res?.context?.join("\n") ?? "";
		expect(joined).toContain("[omp-todo-ng] Todo tree (4 open items)");
		expect(joined).toContain("[omp-actual-terminal] PTY sessions (3 live)");
	});

	test("Plane 1 barrier suppresses mid-compaction callbacks and drains on session_compact, auto_compaction_end, and AbortSignal", async () => {
		const runner = createMockHostRunner();
		registerCompactHandoff(
			runner.createPluginApi(),
			defineStatelessNoiseGuard({ pluginId: "tool-policy-nag", renderNoiseGuardDirective: () => "Ignore lint nags." }),
		);
		const ctx = makeContext([]);
		const sm = ctx.sessionManager;
		const log: string[] = [];

		expect(isCompacting(sm)).toBe(false);
		expect(deferDuringCompaction(sm, "idle", () => log.push("idle-immediate"))).toBe(false);
		expect(log).toEqual(["idle-immediate"]);

		await runner.emitAutoStart({ type: "auto_compaction_start", reason: "threshold", action: "remote" }, ctx);
		expect(isCompacting(sm)).toBe(true);
		expect(deferDuringCompaction(sm, "overtime", () => log.push("overtime-stale"))).toBe(true);
		expect(deferDuringCompaction(sm, "overtime", () => log.push("overtime-latest"))).toBe(true);
		expect(deferDuringCompaction(sm, "pty", () => log.push("pty-wake"))).toBe(true);
		expect(log).toEqual(["idle-immediate"]);

		const cmp: CompactionEntry = {
			type: "compaction",
			id: "cmp_1",
			parentId: null,
			timestamp: "2026-11-22T00:00:00.000Z",
			summary: "s",
			firstKeptEntryId: "k1",
			tokensBefore: 400000,
		};
		await runner.emitCompact({ type: "session_compact", compactionEntry: cmp, fromExtension: false }, ctx);
		expect(isCompacting(sm)).toBe(false);
		expect(log).toEqual(["idle-immediate", "overtime-latest", "pty-wake"]);

		// Drain on aborted auto_compaction_end
		await runner.emitAutoStart({ type: "auto_compaction_start", reason: "overflow", action: "remote" }, ctx);
		expect(deferDuringCompaction(sm, "retry", () => log.push("auto-end-drain"))).toBe(true);
		await runner.emitAutoEnd({ type: "auto_compaction_end", action: "remote", result: undefined, aborted: true, willRetry: false }, ctx);
		expect(isCompacting(sm)).toBe(false);
		expect(log[log.length - 1]).toBe("auto-end-drain");

		// Drain on AbortSignal abort
		const ac = new AbortController();
		enterCompactionBarrier(sm, ac.signal);
		expect(isCompacting(sm)).toBe(true);
		expect(deferDuringCompaction(sm, "sig", () => log.push("signal-abort-drain"))).toBe(true);
		ac.abort();
		expect(isCompacting(sm)).toBe(false);
		expect(log[log.length - 1]).toBe("signal-abort-drain");
		expect(releaseCompactionBarrier(sm)).toBe(0);

		const failedManual = new AbortController();
		await runner.emitBeforeCompact(
			{
				type: "session_before_compact",
				preparation: makePreparation(makeFileOps([])),
				branchEntries: [],
				signal: failedManual.signal,
			},
			ctx,
		);
		expect(isCompacting(sm)).toBe(true);
		expect(deferDuringCompaction(sm, "after-failed-manual", () => log.push("agent-start-drain"))).toBe(true);
		await runner.emitAgentStart({ type: "agent_start" }, ctx);
		expect(isCompacting(sm)).toBe(false);
		expect(log[log.length - 1]).toBe("agent-start-drain");

		await runner.emitAutoStart({ type: "auto_compaction_start", reason: "threshold", action: "remote" }, ctx);
		await runner.emitAgentStart({ type: "agent_start" }, ctx);
		expect(isCompacting(sm)).toBe(true);
		await runner.emitAutoEnd({ type: "auto_compaction_end", action: "remote", result: undefined, aborted: false, willRetry: false }, ctx);
		expect(isCompacting(sm)).toBe(false);
	});

	test("a newer revision at the registry key adopts the store and serves handlers attached by an older copy", async () => {
		const runner = createMockHostRunner();
		registerCompactHandoff(
			runner.createPluginApi(),
			defineStatelessNoiseGuard({ pluginId: "older-plugin", renderNoiseGuardDirective: () => "Ignore nags." }),
		);
		const current = getSharedCompactCoordinator();

		class OlderCoordinator extends SharedCompactCoordinator {
			override readonly revision = COMPACT_HANDOFF_REVISION - 1;
		}
		Reflect.set(globalThis, COMPACT_REGISTRY_SYMBOL, new OlderCoordinator(current.store));
		const adopted = getSharedCompactCoordinator();
		expect(adopted).not.toBeInstanceOf(OlderCoordinator);
		expect(adopted.revision).toBe(COMPACT_HANDOFF_REVISION);
		expect(adopted.store).toBe(current.store);
		expect(adopted.listPluginIds()).toEqual(["older-plugin"]);

		class NewerCoordinator extends SharedCompactCoordinator {
			override readonly revision = COMPACT_HANDOFF_REVISION + 1;
			override handleCompacting(): SessionCompactingResult {
				return { context: ["served-by-newer"] };
			}
		}
		Reflect.set(globalThis, COMPACT_REGISTRY_SYMBOL, new NewerCoordinator(adopted.store));
		expect(getSharedCompactCoordinator()).toBeInstanceOf(NewerCoordinator);

		const res = await runner.emitCompacting({ type: "session.compacting", sessionId: "s", messages: [] }, makeContext([]));
		expect(res?.context).toEqual(["served-by-newer"]);
		expect(runner.count("session.compacting")).toBe(1);

		const legacyWithoutRevision = { register() {}, attachToHost() {}, isCompacting: () => false, deferDuringCompaction: () => false };
		Reflect.set(globalThis, COMPACT_REGISTRY_SYMBOL, legacyWithoutRevision);
		const replaced = getSharedCompactCoordinator();
		expect(replaced.revision).toBe(COMPACT_HANDOFF_REVISION);
		expect(Reflect.get(globalThis, COMPACT_REGISTRY_SYMBOL)).toBe(replaced);
	});

	test("COMPACT_HANDOFF_REVISION is the newest revision and names the current file content", async () => {
		const text = await Bun.file(new URL("../src/compact-handoff.ts", import.meta.url)).text();
		const sha = new Bun.CryptoHasher("sha256").update(text).digest("hex");
		expect(Math.max(...Object.keys(REVISION_SHA256).map(Number))).toBe(COMPACT_HANDOFF_REVISION);
		expect(REVISION_SHA256[COMPACT_HANDOFF_REVISION]).toBe(sha);
	});

	test("prunePreparationFileOpsInPlace strips ?q=/:jq:, filters external noise, and rescues top-20 recency-ranked repo files", () => {
		expect(normalizeFilePath("src/a.ts?q=.x").path).toBe("src/a.ts");
		expect(normalizeFilePath("src/a.ts:jq:.x").path).toBe("src/a.ts");
		expect(normalizeFilePath("src/a.ts:10-20").path).toBe("src/a.ts");
		expect(normalizeFilePath("/tmp/foo.txt").path).toBeNull();
		expect(normalizeFilePath("/Users/u/.claude/skills/x/SKILL.md").path).toBeNull();
		expect(normalizeFilePath("/Users/u/.local/state/ghc/a/record.json?q={shows}").path).toBeNull();
		expect(normalizeFilePath("/Users/u/.omp/agent/config.yml").path).toBeNull();

		const reads: string[] = [
			".gitignore",
			".github/workflows/ci.yml",
			"/tmp/scratch.log",
			"/Users/u/.claude/rules/r.md",
			"/Users/u/.local/state/ghc/org/repo/1/record.json?q={shows}",
			"/Users/u/.omp/agent/sessions/s.jsonl:jq:.type",
		];
		for (let i = 1; i <= 25; i++) reads.push(`/repo/src/mod-${String(i).padStart(2, "0")}.ts?q=.meta`);
		const fileOps = makeFileOps(reads, ["/repo/src/hot-edit.ts"], ["/repo/tests/new-test.ts"]);
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/repo/src/mod-25.ts" } },
					{ type: "toolCall", id: "t2", name: "read", arguments: { path: "/repo/src/mod-24.ts" } },
				],
				timestamp: 1,
			} as unknown as AgentMessage,
		];

		const report = prunePreparationFileOpsInPlace(fileOps, messages, "/repo", 20);
		expect(report.strippedQueryCount).toBeGreaterThan(20);
		expect(report.filteredNoiseCount).toBe(4);
		expect(report.selectedCount).toBe(20);
		expect(report.repoSourcePathsSelected.length).toBe(20);
		expect(report.selectedPaths[0]).toBe("tests/new-test.ts");
		expect(report.selectedPaths[1]).toBe("src/hot-edit.ts");
		// Most recently read repo files appear immediately after modified files
		expect(report.selectedPaths[2]).toBe("src/mod-24.ts");
		expect(report.selectedPaths[3]).toBe("src/mod-25.ts");
		expect(fileOps.read.has("src/mod-25.ts")).toBe(true);
		expect(fileOps.edited.has("src/hot-edit.ts")).toBe(true);
		expect(fileOps.written.has("tests/new-test.ts")).toBe(true);
	});

	test("computeSafePostCompactInsertIndex preserves soft compaction idx+1 and anthropicCompaction fold boundary index 4", () => {
		const softMultiSummary = [
			{ role: "compactionSummary", summary: "old", timestamp: 1 },
			{ role: "user", content: "a", timestamp: 2 },
			{ role: "compactionSummary", summary: "new", timestamp: 3 },
			{ role: "user", content: "b", timestamp: 4 },
		] as unknown as AgentMessage[];
		expect(computeSafePostCompactInsertIndex(softMultiSummary)).toBe(3);

		const anthropicFold = [
			{
				role: "compactionSummary",
				summary: "s",
				timestamp: 1,
				providerPayload: { type: "anthropicCompaction", provider: "anthropic", content: "s", signature: "sig" },
			},
			{ role: "assistant", content: [], timestamp: 2 },
			{ role: "toolResult", toolCallId: "t1", content: [], timestamp: 3 },
			{ role: "toolResult", toolCallId: "t2", content: [], timestamp: 4 },
			{ role: "user", content: "next", timestamp: 5 },
		] as unknown as AgentMessage[];
		expect(computeSafePostCompactInsertIndex(anthropicFold)).toBe(4);
		expect(computeSafePostCompactInsertIndex([{ role: "user", content: "only", timestamp: 1 }])).toBe(0);
	});

	test("one prompt for initial and update windows, one-line context items, both delivery modes, and hook error isolation", async () => {
		expect(COMPACTION_PROMPT).toContain("## User Intent & Session Rulings");
		expect(COMPACTION_PROMPT).toContain("## Decisions & Ruled-Out Approaches");
		expect(COMPACTION_PROMPT).toContain("## Discovered Code Anchors & Contracts");
		expect(COMPACTION_PROMPT).toContain("## Landed Milestones & Active Verification State");
		expect(COMPACTION_PROMPT).toContain("## Handoff to Kept Tail");
		expect(COMPACTION_PROMPT).toContain("When a `<previous-summary>` block appears above, update that summary");
		expect(COMPACTION_PROMPT).not.toContain("Additional focus");
		expect(COMPACTION_PROMPT).not.toMatch(/\d+k[- ]token/);

		const runner = createMockHostRunner();
		const pi = runner.createPluginApi();

		registerCompactHandoff(
			pi,
			defineStatefulHarnessHandoff<{ ok: true }>({
				pluginId: "delta-plugin",
				captureState: () => ({ ok: true }),
				renderCompactPromptClaim: () => "Delta state owned by delta-plugin",
				renderPostCompactInjection: () => ({
					source: "delta-plugin/state",
					delivery: "delta-stream",
					content: "delta-body",
				}),
			}),
		);
		registerCompactHandoff(
			pi,
			defineStatefulHarnessHandoff<{ ok: true }>({
				pluginId: "managed-plugin",
				captureState: () => ({ ok: true }),
				renderCompactPromptClaim: () => "Managed state owned by managed-plugin\nacross two lines",
				renderPostCompactInjection: () => ({
					source: "managed-plugin/state",
					delivery: "plugin-managed",
				}),
			}),
		);
		registerCompactHandoff(
			pi,
			defineStatelessNoiseGuard({
				pluginId: "tool-policy-nag",
				renderNoiseGuardDirective: () => "Ignore automated lint nags.",
			}),
		);

		const keptUser: SessionEntry = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-11-22T00:00:00.000Z",
			message: { role: "user", content: "continue", timestamp: 1 },
		};
		const cmpEntry: CompactionEntry = {
			type: "compaction",
			id: "cmp_3modes",
			parentId: "u1",
			timestamp: "2026-11-22T00:01:00.000Z",
			summary: "summary",
			firstKeptEntryId: "u1",
			tokensBefore: 400000,
		};
		const ctx = makeContext([keptUser, cmpEntry]);

		const compactingRes = await runner.emitCompacting({ type: "session.compacting", sessionId: "s3", messages: [] }, ctx);
		expect(compactingRes?.prompt).toBe(COMPACTION_PROMPT);
		const items = compactingRes?.context ?? [];
		for (const item of items) {
			expect(item).not.toContain("\n");
			expect(item.startsWith("harness-provided [") || item.startsWith("noise-guard [")).toBe(true);
		}
		expect(items).toContain("harness-provided [delta-plugin] Delta state owned by delta-plugin");
		expect(items).toContain("harness-provided [managed-plugin] Managed state owned by managed-plugin across two lines");
		expect(items).toContain("noise-guard [tool-policy-nag] Ignore automated lint nags.");
		expect(items.filter((item) => item.startsWith("harness-provided [omp-core]")).length).toBe(4);

		await runner.emitCompact({ type: "session_compact", compactionEntry: cmpEntry, fromExtension: false }, ctx);
		const startRes = await runner.emitBeforeAgentStart(
			{ type: "before_agent_start", reason: "prompt", prompt: "go", systemPrompt: [] },
			ctx,
		);
		expect(startRes.length).toBe(1);
		const msgContent = typeof startRes[0]?.message === "object" ? String(startRes[0].message.content) : "";
		expect(msgContent).toContain('<system-reminder source="delta-plugin/state">');
		expect(msgContent).toContain("delta-body");
		expect(msgContent).not.toContain("managed-plugin/state");

		// 3. Throwing contribution is caught & warned rather than crashing omp
		registerCompactHandoff(
			pi,
			defineStatelessNoiseGuard({
				pluginId: "throwing-guard",
				renderNoiseGuardDirective: () => {
					throw new Error("boom");
				},
			}),
		);
		const freshCtx = makeContext([]);
		const safeRes = await runner.emitCompacting({ type: "session.compacting", sessionId: "err", messages: [] }, freshCtx);
		expect(safeRes).toBeUndefined();
		expect(runner.warnings.some((w) => w.includes("session.compacting"))).toBe(true);
	});
});
