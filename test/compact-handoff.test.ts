import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage, CompactionPreparation, FileOperations } from "@oh-my-pi/pi-agent-core";
import type {
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	CompactionEntry,
	ContextEvent,
	ContextEventResult,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
	SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import {
	buildExternalCompactionPrompt,
	COMPACT_REGISTRY_SYMBOL,
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
} from "../src/compact-handoff.ts";

type CompactHandoffModule = typeof import("../src/compact-handoff.ts");
type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;

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
		async emitContext(event: ContextEvent, ctx: ExtensionContext): Promise<ContextEventResult | undefined> {
			let messages = event.messages;
			let modified = false;
			for (const h of handlers.get("context") ?? []) {
				const r = (await h({ ...event, messages }, ctx)) as ContextEventResult | undefined;
				if (r?.messages) {
					messages = r.messages;
					modified = true;
				}
			}
			return modified ? { messages } : undefined;
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
				pluginId: "omp-todo-more",
				captureState: () => ({ count: 4 }),
				renderCompactPromptClaim: (s) => `Todo tree (${s.count} open items)`,
				renderPostCompactInjection: () => ({ source: "omp-todo-more/planning", delivery: "plugin-managed" }),
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
		expect(joined).toContain("[omp-todo-more] Todo tree (4 open items)");
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

	test("5-section prompt assembly and all 3 delivery modes (delta-stream, session-compact-message, plugin-managed) + hook error isolation", async () => {
		const prompt = buildExternalCompactionPrompt({ isUpdate: true, customInstructions: "Keep SHAs" });
		expect(prompt).toContain("## User Intent & Session Rulings");
		expect(prompt).toContain("## Decisions & Ruled-Out Approaches");
		expect(prompt).toContain("## Discovered Code Anchors & Contracts");
		expect(prompt).toContain("## Landed Milestones & Active Verification State");
		expect(prompt).toContain("## Handoff to Kept Tail");
		expect(prompt).toContain("Additional focus: Keep SHAs");

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
				pluginId: "splice-plugin",
				captureState: () => ({ ok: true }),
				renderCompactPromptClaim: () => "Splice state owned by splice-plugin",
				renderPostCompactInjection: () => ({
					source: "splice-plugin/state",
					delivery: "session-compact-message",
					content: "splice-body",
				}),
			}),
		);
		registerCompactHandoff(
			pi,
			defineStatefulHarnessHandoff<{ ok: true }>({
				pluginId: "managed-plugin",
				captureState: () => ({ ok: true }),
				renderCompactPromptClaim: () => "Managed state owned by managed-plugin",
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

		// Calling `session.compacting` directly without `session_before_compact` builds fallback snapshot cleanly
		const compactingRes = await runner.emitCompacting({ type: "session.compacting", sessionId: "s3", messages: [] }, ctx);
		const extra = compactingRes?.context?.join("\n") ?? "";
		expect(extra).toContain("<harness-provided>");
		expect(extra).toContain("[delta-plugin]");
		expect(extra).toContain("[splice-plugin]");
		expect(extra).toContain("[managed-plugin]");
		expect(extra).toContain("<attribution-and-noise-guard>");
		expect(extra).toContain("[tool-policy-nag] Ignore automated lint nags.");

		await runner.emitCompact({ type: "session_compact", compactionEntry: cmpEntry, fromExtension: false }, ctx);

		// 1. `session-compact-message` splices at fold-safe index 4 (and never duplicates if re-run!)
		const baseMsgs = [
			{
				role: "compactionSummary",
				summary: "s",
				timestamp: 1,
				providerPayload: { type: "anthropicCompaction", provider: "anthropic", content: "s", signature: "sig" },
			},
			{ role: "assistant", content: [], timestamp: 2 },
			{ role: "toolResult", toolCallId: "t1", content: [], timestamp: 3 },
			{ role: "toolResult", toolCallId: "t2", content: [], timestamp: 4 },
			{ role: "user", content: "go", timestamp: 5 },
		] as unknown as AgentMessage[];
		const spliced1 = await runner.emitContext({ type: "context", messages: baseMsgs }, ctx);
		expect(spliced1?.messages?.length).toBe(6);
		expect((spliced1!.messages![4] as { customType?: string }).customType).toBe("splice-plugin/state");
		const spliced2 = await runner.emitContext({ type: "context", messages: spliced1!.messages! }, ctx);
		expect(spliced2).toBeUndefined(); // deduplicated

		// 2. `delta-stream` delivers via real `createDeltaStream`, while `plugin-managed` is NOT double-injected!
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
