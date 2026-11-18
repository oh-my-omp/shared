import { describe, expect, test } from "bun:test";
import { isTodoReadRequest, readTodos, TODO_READ_EVENT, type TodoReadCounts, type TodoReadRequest } from "../src/todo-read.ts";

/** In-process stand-in for the host EventBus: emit calls listeners synchronously. */
function bus(...listeners: ((data: unknown) => void)[]): { emit(channel: string, data: unknown): void } {
	return {
		emit(channel, data) {
			if (channel !== TODO_READ_EVENT) return;
			for (const listener of listeners) listener(data);
		},
	};
}

/** Producer built the way the owner builds it: validate with the shared request parser, then reply. */
function producer(reply: (request: TodoReadRequest) => unknown): (data: unknown) => void {
	return (data) => {
		if (!isTodoReadRequest(data)) return;
		data.reply(reply(data));
	};
}

const AGENT = "agent-357";

describe("readTodos", () => {
	test("an answering producer yields ok with counts summing to the list length", () => {
		const counts: TodoReadCounts = { pending: 1, in_progress: 1, completed: 2, abandoned: 0, blocked: 1 };
		const goal = { objective: "ship", measure: "tests pass", doneWhen: "green" };
		const openItems = [
			{ phase: "build", title: "wire it", explanation: "the reason" },
			{ phase: "verify", title: "run it", explanation: null },
		];
		const events = bus(producer(() => ({ kind: "ok", goal, openItems, counts })));
		const result = readTodos(events, AGENT);
		expect(result).toEqual({ kind: "ok", goal, openItems, counts });
		if (result.kind === "ok") {
			expect(Object.values(result.counts).reduce((sum, n) => sum + n, 0)).toBe(5);
		}
	});

	test("no listener yields no_reply", () => {
		expect(readTodos(bus(), AGENT)).toEqual({ kind: "no_reply" });
	});

	test("a reply missing counts yields malformed naming counts", () => {
		const events = bus(producer(() => ({ kind: "ok", goal: null, openItems: [] })));
		const result = readTodos(events, AGENT);
		expect(result.kind).toBe("malformed");
		if (result.kind === "malformed") expect(result.reason).toContain("counts");
	});

	test("a malformed item yields malformed naming the element", () => {
		const events = bus(
			producer(() => ({
				kind: "ok",
				goal: null,
				openItems: [
					{ phase: "p", title: "t", explanation: null },
					{ phase: 1, title: "t", explanation: null },
				],
				counts: { pending: 0, in_progress: 0, completed: 0, abandoned: 0, blocked: 0 },
			})),
		);
		const result = readTodos(events, AGENT);
		expect(result.kind).toBe("malformed");
		if (result.kind === "malformed") expect(result.reason).toContain("openItems[1]");
	});

	test("a producer answering unavailable yields unavailable", () => {
		const events = bus(producer(() => ({ kind: "unavailable" })));
		expect(readTodos(events, AGENT)).toEqual({ kind: "unavailable" });
	});

	test("a throwing listener does not throw out of readTodos", () => {
		const events = bus(() => {
			throw new Error("listener blew up");
		});
		expect(readTodos(events, AGENT)).toEqual({ kind: "no_reply" });
	});

	test("a request the producer does not recognize yields no_reply", () => {
		const events = bus((data) => {
			expect(isTodoReadRequest(data)).toBe(true);
			expect(isTodoReadRequest({ agentId: "  ", reply: () => {} })).toBe(false);
			expect(isTodoReadRequest({ agentId: AGENT })).toBe(false);
		});
		expect(readTodos(events, AGENT)).toEqual({ kind: "no_reply" });
	});
});
