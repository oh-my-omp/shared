import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionEntry, CustomMessageEntry, ExtensionContext, SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent";
import { createDeltaStream, type Delta } from "../src/context-delta.ts";

const SOURCE = "probe/delta";
const BODY_ONE = "first body";
const BODY_TWO = "second body";

const text = (body: string): Delta => ({ kind: "text", body });
const none: Delta = { kind: "none" };

function block(source: string, inner: string): string {
	return `<system-reminder source="${source}">\n${inner}\n</system-reminder>`;
}

function firstBlock(source: string, body: string): string {
	return block(source, body);
}

function supersedeBlock(source: string, body: string): string {
	return block(source, `This reminder supersedes every earlier reminder from ${source}; only this one applies.\n\n${body}`);
}

function retractionBlock(source: string): string {
	return block(source, `The earlier reminders from ${source} no longer apply.`);
}

let ids = 0;

function base(parentId: string | null): { id: string; parentId: string | null; timestamp: string } {
	ids += 1;
	return { id: `e${ids}`, parentId, timestamp: "2026-11-19T00:00:00.000Z" };
}

function userEntry(parentId: string | null, content: string): SessionMessageEntry {
	const message: AgentMessage = { role: "user", content, timestamp: 0 };
	return { ...base(parentId), type: "message", message };
}

function developerEntry(parentId: string | null, content: string): SessionMessageEntry {
	const message: AgentMessage = { role: "developer", content, attribution: "agent", timestamp: 0 };
	return { ...base(parentId), type: "message", message };
}

function customEntry(parentId: string | null, source: string, content: string): CustomMessageEntry {
	return { ...base(parentId), type: "custom_message", customType: source, content, display: false, attribution: "agent" };
}

function compactionEntry(parentId: string | null, firstKeptEntryId: string): CompactionEntry {
	return { ...base(parentId), type: "compaction", summary: "summary", firstKeptEntryId, tokensBefore: 100 };
}

function contextOf(chain: SessionEntry[]): ExtensionContext {
	const byId = new Map(chain.map((entry) => [entry.id, entry]));
	const leaf = chain[chain.length - 1];
	const sessionManager = {
		getLeafId: () => (leaf === undefined ? null : leaf.id),
		getEntry: (id: string) => byId.get(id),
		getEntries: () => [...chain],
	};
	return { sessionManager } as unknown as ExtensionContext;
}

describe("atPrompt", () => {
	test("first delivery renders one block with the given source", () => {
		const stream = createDeltaStream(SOURCE);
		const ctx = contextOf([userEntry(null, "hi")]);
		const result = stream.atPrompt(ctx, text(BODY_ONE));
		expect(result).toEqual({
			message: { customType: SOURCE, content: firstBlock(SOURCE, BODY_ONE), display: false, attribution: "agent" },
		});
	});

	test("an identical body is not resent once the context holds it", () => {
		const stream = createDeltaStream(SOURCE);
		const ctx = contextOf([userEntry(null, "hi")]);
		const first = stream.atPrompt(ctx, text(BODY_ONE));
		expect(first).toBeDefined();
		const persisted = customEntry(ctx.sessionManager.getLeafId(), SOURCE, first?.message.content ?? "");
		const again = stream.atPrompt(contextOf([userEntry(null, "hi"), persisted]), text(BODY_ONE));
		expect(again).toBeUndefined();
	});

	test("a changed body supersedes, and the new body becomes the effective one", () => {
		const stream = createDeltaStream(SOURCE);
		const user = userEntry(null, "hi");
		const first = customEntry(user.id, SOURCE, firstBlock(SOURCE, BODY_ONE));
		const result = stream.atPrompt(contextOf([user, first]), text(BODY_TWO));
		expect(result?.message.content).toBe(supersedeBlock(SOURCE, BODY_TWO));
		const second = customEntry(first.id, SOURCE, result?.message.content ?? "");
		expect(stream.atPrompt(contextOf([user, first, second]), text(BODY_TWO))).toBeUndefined();
	});

	test("an empty delta after a body yields a retraction", () => {
		const stream = createDeltaStream(SOURCE);
		const user = userEntry(null, "hi");
		const first = customEntry(user.id, SOURCE, firstBlock(SOURCE, BODY_ONE));
		const result = stream.atPrompt(contextOf([user, first]), none);
		expect(result?.message.content).toBe(retractionBlock(SOURCE));
	});

	test("nothing is sent when nothing applied before and the delta is empty", () => {
		const stream = createDeltaStream(SOURCE);
		expect(stream.atPrompt(contextOf([userEntry(null, "hi")]), none)).toBeUndefined();
	});

	test("nothing is sent when the effective delta is a retraction and the delta stays empty", () => {
		const stream = createDeltaStream(SOURCE);
		const user = userEntry(null, "hi");
		const retraction = customEntry(user.id, SOURCE, retractionBlock(SOURCE));
		expect(stream.atPrompt(contextOf([user, retraction]), none)).toBeUndefined();
	});

	test("a body is delivered again after a retraction, marked as superseding", () => {
		const stream = createDeltaStream(SOURCE);
		const user = userEntry(null, "hi");
		const retraction = customEntry(user.id, SOURCE, retractionBlock(SOURCE));
		const result = stream.atPrompt(contextOf([user, retraction]), text(BODY_TWO));
		expect(result?.message.content).toBe(supersedeBlock(SOURCE, BODY_TWO));
	});

	test("another source's block is not this source's delta", () => {
		const stream = createDeltaStream(SOURCE);
		const user = userEntry(null, "hi");
		const other = customEntry(user.id, "probe/other", firstBlock("probe/other", BODY_ONE));
		const result = stream.atPrompt(contextOf([user, other]), text(BODY_TWO));
		expect(result?.message.content).toBe(firstBlock(SOURCE, BODY_TWO));
	});

	test("a carrier the latest compaction dropped is delivered again", () => {
		const stream = createDeltaStream(SOURCE);
		const dropped = customEntry(null, SOURCE, firstBlock(SOURCE, BODY_ONE));
		const kept = userEntry(dropped.id, "kept tail");
		const compaction = compactionEntry(kept.id, kept.id);
		const result = stream.atPrompt(contextOf([dropped, kept, compaction]), text(BODY_ONE));
		expect(result?.message.content).toBe(firstBlock(SOURCE, BODY_ONE));
	});

	test("a carrier inside the compaction's kept tail is still the effective delta", () => {
		const stream = createDeltaStream(SOURCE);
		const dropped = userEntry(null, "old");
		const kept = customEntry(dropped.id, SOURCE, firstBlock(SOURCE, BODY_ONE));
		const compaction = compactionEntry(kept.id, kept.id);
		expect(stream.atPrompt(contextOf([dropped, kept, compaction]), text(BODY_ONE))).toBeUndefined();
	});
});

describe("afterTools", () => {
	test("first delivery renders one block as additionalContext", () => {
		const stream = createDeltaStream(SOURCE);
		const result = stream.afterTools(contextOf([userEntry(null, "hi")]), text(BODY_ONE));
		expect(result).toEqual({ additionalContext: firstBlock(SOURCE, BODY_ONE) });
	});

	test("an identical body is not resent within the same tool batch", () => {
		const stream = createDeltaStream(SOURCE);
		const ctx = contextOf([userEntry(null, "hi")]);
		expect(stream.afterTools(ctx, text(BODY_ONE))).toBeDefined();
		expect(stream.afterTools(ctx, text(BODY_ONE))).toBeUndefined();
	});

	test("a changed body supersedes", () => {
		const stream = createDeltaStream(SOURCE);
		const user = userEntry(null, "hi");
		const persisted = developerEntry(user.id, firstBlock(SOURCE, BODY_ONE));
		const result = stream.afterTools(contextOf([user, persisted]), text(BODY_TWO));
		expect(result?.additionalContext).toBe(supersedeBlock(SOURCE, BODY_TWO));
	});

	test("an empty delta after a body yields a retraction", () => {
		const stream = createDeltaStream(SOURCE);
		const user = userEntry(null, "hi");
		const persisted = developerEntry(user.id, firstBlock(SOURCE, BODY_ONE));
		const result = stream.afterTools(contextOf([user, persisted]), none);
		expect(result?.additionalContext).toBe(retractionBlock(SOURCE));
	});

	test("nothing is sent when nothing applied before and the delta is empty", () => {
		const stream = createDeltaStream(SOURCE);
		expect(stream.afterTools(contextOf([userEntry(null, "hi")]), none)).toBeUndefined();
	});

	test("a delivery the turn discarded is sent again after turnStarted", () => {
		const stream = createDeltaStream(SOURCE);
		const ctx = contextOf([userEntry(null, "hi")]);
		expect(stream.afterTools(ctx, text(BODY_ONE))).toBeDefined();
		stream.turnStarted();
		expect(stream.afterTools(ctx, text(BODY_ONE))).toEqual({ additionalContext: firstBlock(SOURCE, BODY_ONE) });
	});
});
