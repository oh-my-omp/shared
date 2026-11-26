import { describe, expect, test } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import { z } from "@oh-my-pi/omptype/zod";
import { omompTool, verbatim } from "../src/tool-entry.ts";

interface CapturedCall {
	params: unknown;
	rest: unknown[];
}

function zodTool() {
	return z.object({
		op: z.enum(["run", "stop"]).describe("operation"),
		mode: z.enum(["trash", "permanent"]).optional().describe("deletion mode"),
		note: z.string().optional().describe("free text note"),
		id: z.string().min(1).optional().describe("identifier"),
		code: z
			.string()
			.regex(/^[a-z]+$/)
			.optional()
			.describe("lowercase code"),
		minutes: z.number().positive().optional().describe("positive minutes"),
		items: z.array(z.string()).optional().describe("item list"),
		chars: verbatim(z.string().optional().describe("verbatim input")),
		count: z.number().optional().describe("count"),
		flag: z.boolean().optional().describe("switch"),
		filter: z
			.object({
				inner: z.string().optional().describe("nested text"),
				deep: z
					.object({ leaf: z.string().optional().describe("deep leaf") })
					.optional()
					.describe("nested object"),
			})
			.optional()
			.describe("filter group"),
		rows: z
			.array(z.object({ cell: z.string().optional().describe("cell text") }))
			.optional()
			.describe("object rows"),
	});
}

function typeboxTool() {
	return Type.Object({
		op: Type.Enum(["run", "stop"], { description: "operation" }),
		mode: Type.Optional(Type.Enum(["trash", "permanent"], { description: "deletion mode" })),
		note: Type.Optional(Type.String({ description: "free text note" })),
		id: Type.Optional(Type.String({ minLength: 1, description: "identifier" })),
		code: Type.Optional(Type.String({ pattern: "^[a-z]+$", description: "lowercase code" })),
		minutes: Type.Optional(Type.Number({ minimum: 1, description: "positive minutes" })),
		items: Type.Optional(Type.Array(Type.String(), { description: "item list" })),
		chars: verbatim(Type.Optional(Type.String({ description: "verbatim input" }))),
		count: Type.Optional(Type.Number({ description: "count" })),
		flag: Type.Optional(Type.Boolean({ description: "switch" })),
		filter: Type.Optional(
			Type.Object(
				{
					inner: Type.Optional(Type.String({ description: "nested text" })),
					deep: Type.Optional(
						Type.Object({ leaf: Type.Optional(Type.String({ description: "deep leaf" })) }, { description: "nested object" }),
					),
				},
				{ description: "filter group" },
			),
		),
		rows: Type.Optional(
			Type.Array(Type.Object({ cell: Type.Optional(Type.String({ description: "cell text" })) }), { description: "object rows" }),
		),
	});
}

function makeTool(parameters: unknown) {
	const calls: CapturedCall[] = [];
	const definition = omompTool({
		name: "probe",
		label: "probe",
		description: "probe tool",
		parameters,
		execute(_toolCallId: string, params: unknown, ...rest: unknown[]) {
			calls.push({ params, rest });
			return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
		},
	});
	return { definition, calls };
}

type ExecutableDefinition = { execute: (toolCallId: string, params: unknown, ...rest: unknown[]) => unknown };

async function executeWith(definition: ExecutableDefinition, args: Record<string, unknown>) {
	return definition.execute("call-1", args, undefined, undefined, {});
}

async function refusalOf(definition: ExecutableDefinition, args: Record<string, unknown>): Promise<string> {
	try {
		await executeWith(definition, args);
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw new Error("refusal was not an Error");
	}
	throw new Error("expected the call to be refused");
}

for (const [flavor, parameters] of [
	["zod", zodTool()],
	["typebox", typeboxTool()],
] as const) {
	describe(`omompTool (${flavor})`, () => {
		test("blank optional enum, min(1), regex and plain string fields are omitted instead of refused", async () => {
			const { definition, calls } = makeTool(parameters);
			const result = await executeWith(definition, { op: "run", mode: " ", note: "  ", id: " ", code: " " });
			expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
			expect(calls).toHaveLength(1);
			expect(calls[0]?.params).toEqual({ op: "run" });
		});

		test("empty arrays and nulls are omitted", async () => {
			const { definition, calls } = makeTool(parameters);
			await executeWith(definition, {
				op: "run",
				items: [],
				note: null,
				mode: null,
				count: null,
			});
			expect(calls[0]?.params).toEqual({ op: "run" });
		});

		test('the strings "[]" and "{}" on string fields are real input, and 0/false survive', async () => {
			const { definition, calls } = makeTool(parameters);
			await executeWith(definition, { op: "run", note: "[]", id: "{}", count: 0, flag: false });
			expect(calls[0]?.params).toEqual({ op: "run", note: "[]", id: "{}", count: 0, flag: false });
		});

		test("a required field left blank is refused exactly as omitting it", async () => {
			const { definition, calls } = makeTool(parameters);
			const blankError = await refusalOf(definition, { op: " ", note: "x" });
			const omittedError = await refusalOf(definition, { note: "x" });
			expect(blankError).toBe(omittedError);
			expect(calls).toHaveLength(0);
		});

		test("an empty array element refuses with field path and index, execute never runs", async () => {
			const { definition, calls } = makeTool(parameters);
			const message = await refusalOf(definition, { op: "run", items: ["a", " ", "c"] });
			expect(message.startsWith('Validation failed for tool "probe"')).toBe(true);
			expect(message).toContain("items[1]");
			expect(calls).toHaveLength(0);
		});

		test("an object element that normalizes to {} refuses with path and index", async () => {
			const { definition, calls } = makeTool(parameters);
			const message = await refusalOf(definition, { op: "run", rows: [{ cell: "ok" }, { cell: " " }] });
			expect(message).toContain("rows[1]");
			expect(calls).toHaveLength(0);
		});

		test("a null array element refuses whatever the element type", async () => {
			const { definition, calls } = makeTool(parameters);
			const message = await refusalOf(definition, { op: "run", items: ["a", null] });
			expect(message).toContain("items[1]");
			expect(calls).toHaveLength(0);
		});

		test("verbatim fields keep whitespace-only values and drop only the empty string", async () => {
			const { definition, calls } = makeTool(parameters);
			await executeWith(definition, { op: "run", chars: " " });
			expect(calls[0]?.params).toEqual({ op: "run", chars: " " });
			await executeWith(definition, { op: "run", chars: "\n" });
			expect(calls[1]?.params).toEqual({ op: "run", chars: "\n" });
			await executeWith(definition, { op: "run", chars: "\t" });
			expect(calls[2]?.params).toEqual({ op: "run", chars: "\t" });
			await executeWith(definition, { op: "run", chars: "" });
			expect(calls[3]?.params).toEqual({ op: "run" });
		});

		test("a non-empty invalid enum value carries the host refusal text and execute never runs", async () => {
			const { definition, calls } = makeTool(parameters);
			const message = await refusalOf(definition, { op: "bogus" });
			expect(message.startsWith('Validation failed for tool "probe"')).toBe(true);
			expect(message).toContain("bogus");
			expect(calls).toHaveLength(0);
		});

		test("a non-empty value violating a numeric constraint is refused with the host text", async () => {
			const { definition, calls } = makeTool(parameters);
			const message = await refusalOf(definition, { op: "run", minutes: 0 });
			expect(message.startsWith('Validation failed for tool "probe"')).toBe(true);
			expect(calls).toHaveLength(0);
		});

		test("the host repairs enum whitespace before execute sees the value", async () => {
			const { definition, calls } = makeTool(parameters);
			await executeWith(definition, { op: "run", mode: " trash " });
			expect(calls[0]?.params).toEqual({ op: "run", mode: "trash" });
		});

		test("a stringified array is repaired by the host before execute sees it", async () => {
			const { definition, calls } = makeTool(parameters);
			await executeWith(definition, { op: "run", items: '["a","b"]' });
			expect(calls[0]?.params).toEqual({ op: "run", items: ["a", "b"] });
		});

		test("a stringified empty array is omitted after repair", async () => {
			const { definition, calls } = makeTool(parameters);
			await executeWith(definition, { op: "run", items: "[]" });
			expect(calls[0]?.params).toEqual({ op: "run" });
		});

		test("undeclared root keys never reach execute", async () => {
			const { definition, calls } = makeTool(parameters);
			await executeWith(definition, { op: "run", extra: 1, another: { nested: true } });
			expect(calls[0]?.params).toEqual({ op: "run" });
		});

		test("nested object fields emptied bottom-up are omitted", async () => {
			const { definition, calls } = makeTool(parameters);
			await executeWith(definition, { op: "run", filter: { inner: " ", deep: { leaf: "  " } } });
			expect(calls[0]?.params).toEqual({ op: "run" });
		});

		test("nested undeclared keys follow the schema library extras policy", async () => {
			const { definition, calls } = makeTool(parameters);
			await executeWith(definition, { op: "run", filter: { inner: " ", unknownKey: 1 } });
			if (flavor === "typebox") {
				expect(calls[0]?.params).toEqual({ op: "run", filter: { unknownKey: 1 } });
			} else {
				expect(calls[0]?.params).toEqual({ op: "run" });
			}
		});

		test("the returned definition carries lenientArgValidation", () => {
			const { definition } = makeTool(parameters);
			expect("lenientArgValidation" in definition && definition.lenientArgValidation === true).toBe(true);
		});
	});
}

describe("verbatim", () => {
	test("the emitted JSON Schema is unchanged by the marker", () => {
		const plain = z.string().optional().describe("input");
		const marked = verbatim(z.string().optional().describe("input"));
		expect(JSON.stringify(marked.toJsonSchema())).toBe(JSON.stringify(plain.toJsonSchema()));
		const plainTb = Type.Optional(Type.String({ description: "input" }));
		const markedTb = verbatim(Type.Optional(Type.String({ description: "input" })));
		expect(JSON.stringify(markedTb.toJsonSchema())).toBe(JSON.stringify(plainTb.toJsonSchema()));
	});

	test("marking one schema does not poison other string schemas", async () => {
		verbatim(z.string().optional().describe("input"));
		const parameters = z.object({
			note: z.string().optional().describe("ordinary note"),
		});
		const { definition, calls } = makeTool(parameters);
		await executeWith(definition, { note: " " });
		expect(calls[0]?.params).toEqual({});
	});
});
