import { validateToolArguments } from "@oh-my-pi/pi-ai";

interface IrNode {
	k: string;
	members?: IrNode[];
	el?: IrNode;
	props?: IrProp[];
	input?: IrNode;
	base?: IrNode;
	schema?: EmbeddableSchemaLike;
	index?: IrNode;
	extras?: string;
	resolve?: () => IrNode;
	v?: unknown;
	[verbatimMarker]?: true;
}

interface IrProp {
	key: PropertyKey;
	opt: boolean;
	val: IrNode;
}

interface EmbeddableSchemaLike {
	ir: IrNode;
	[verbatimMarker]?: true;
}

const verbatimMarker: unique symbol = Symbol("omomp.verbatim");

function isEmbeddableSchema(value: unknown): value is EmbeddableSchemaLike {
	return (
		(typeof value === "function" || (typeof value === "object" && value !== null)) &&
		typeof (value as EmbeddableSchemaLike).ir === "object" &&
		(value as EmbeddableSchemaLike).ir !== null &&
		typeof (value as EmbeddableSchemaLike).ir.k === "string"
	);
}

function markVerbatim(schema: unknown, visited: Set<unknown>): void {
	if (!isEmbeddableSchema(schema) || visited.has(schema)) return;
	visited.add(schema);
	if (!(verbatimMarker in schema.ir)) {
		schema.ir = { ...schema.ir, [verbatimMarker]: true };
	}
	Object.defineProperty(schema, verbatimMarker, { value: true, enumerable: false, configurable: true });
	for (const value of Object.values(schema)) {
		if (isEmbeddableSchema(value)) markVerbatim(value, visited);
	}
	for (const key of Object.getOwnPropertySymbols(schema)) {
		if (key === verbatimMarker) continue;
		const value: unknown = Reflect.get(schema, key);
		if (isEmbeddableSchema(value)) markVerbatim(value, visited);
	}
}

export function verbatim<S>(schema: S): S {
	if (!isEmbeddableSchema(schema)) throw new Error("verbatim() requires a schema created by @oh-my-pi/omptype");
	markVerbatim(schema, new Set());
	return schema;
}

type FieldKind = "string" | "array" | "object" | "other";

interface FieldType {
	kind: FieldKind;
	verbatim: boolean;
}

function classifyField(node: IrNode, verbatim: boolean, depth: number): FieldType {
	if (depth > 12) return { kind: "other", verbatim };
	const own = verbatim || node[verbatimMarker] === true;
	switch (node.k) {
		case "string":
			return { kind: "string", verbatim: own };
		case "lit":
			return typeof node.v === "string" ? { kind: "string", verbatim: own } : { kind: "other", verbatim: own };
		case "array":
			return { kind: "array", verbatim: own };
		case "object":
		case "anyobject":
			return { kind: "object", verbatim: own };
		case "union": {
			const members = (node.members ?? []).filter((member) => member.k !== "undefined" && member.k !== "null");
			if (members.length === 0) return { kind: "other", verbatim: own };
			if (members.length === 1 && members[0] !== undefined) return classifyField(members[0], own, depth + 1);
			if (members.every((member) => member.k === "string" || (member.k === "lit" && typeof member.v === "string"))) {
				return { kind: "string", verbatim: own };
			}
			return { kind: "other", verbatim: own };
		}
		case "morph":
			return node.input === undefined ? { kind: "other", verbatim: own } : classifyField(node.input, own, depth + 1);
		case "refine":
			return node.base === undefined ? { kind: "other", verbatim: own } : classifyField(node.base, own, depth + 1);
		case "sub": {
			if (!isEmbeddableSchema(node.schema)) return { kind: "other", verbatim: own };
			const inner = own || node.schema[verbatimMarker] === true || node.schema.ir[verbatimMarker] === true;
			return classifyField(node.schema.ir, inner, depth + 1);
		}
		case "alias": {
			if (node.resolve === undefined) return { kind: "other", verbatim: own };
			try {
				return classifyField(node.resolve(), own, depth + 1);
			} catch {
				return { kind: "other", verbatim: own };
			}
		}
		default:
			return { kind: "other", verbatim: own };
	}
}

function isEmptyValue(value: unknown, field: FieldType): boolean {
	if (value === null) return true;
	switch (field.kind) {
		case "string":
			if (typeof value !== "string") return false;
			return field.verbatim ? value.length === 0 : value.trim().length === 0;
		case "array":
			return Array.isArray(value) && value.length === 0;
		case "object":
			return typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0;
		case "other":
			return false;
	}
}

interface ElementRefusal {
	path: string;
	index: number;
}

function objectNodeOf(node: IrNode, depth: number): IrNode | undefined {
	if (depth > 12) return undefined;
	switch (node.k) {
		case "object":
			return node;
		case "morph":
			return node.input === undefined ? undefined : objectNodeOf(node.input, depth + 1);
		case "refine":
			return node.base === undefined ? undefined : objectNodeOf(node.base, depth + 1);
		case "sub":
			return isEmbeddableSchema(node.schema) ? objectNodeOf(node.schema.ir, depth + 1) : undefined;
		default:
			return undefined;
	}
}

function arrayNodeOf(node: IrNode, depth: number): IrNode | undefined {
	if (depth > 12) return undefined;
	switch (node.k) {
		case "array":
			return node;
		case "morph":
			return node.input === undefined ? undefined : arrayNodeOf(node.input, depth + 1);
		case "refine":
			return node.base === undefined ? undefined : arrayNodeOf(node.base, depth + 1);
		case "sub":
			return isEmbeddableSchema(node.schema) ? arrayNodeOf(node.schema.ir, depth + 1) : undefined;
		default:
			return undefined;
	}
}

function peelOptional(node: IrNode): IrNode {
	if (node.k !== "union" || node.members === undefined) return node;
	const members = node.members.filter((member) => member.k !== "undefined" && member.k !== "null");
	return members.length === 1 && members[0] !== undefined ? members[0] : node;
}

function structuralObjectNode(node: IrNode): IrNode | undefined {
	return objectNodeOf(peelOptional(node), 0);
}

function structuralArrayNode(node: IrNode): IrNode | undefined {
	return arrayNodeOf(peelOptional(node), 0);
}

function pathJoin(base: string, key: string): string {
	return base === "" ? key : `${base}.${key}`;
}

type NormalizedField = { empty: true } | { empty: false; value: unknown; changed: boolean };

function normalizeField(node: IrNode, value: unknown, path: string, refusals: ElementRefusal[], depth: number): NormalizedField {
	if (depth > 12) return { empty: false, value, changed: false };
	const field = classifyField(node, false, 0);
	if (isEmptyValue(value, field)) return { empty: true };
	if (typeof value !== "object" || value === null) return { empty: false, value, changed: false };

	if (Array.isArray(value)) {
		const arrayNode = structuralArrayNode(node);
		if (arrayNode?.el === undefined) return { empty: false, value, changed: false };
		let changed = false;
		const elements: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			const element = normalizeField(arrayNode.el, value[index], `${path}[${index}]`, refusals, depth + 1);
			if (element.empty) {
				refusals.push({ path, index });
				elements.push(value[index]);
				continue;
			}
			if (element.changed) changed = true;
			elements.push(element.changed ? element.value : value[index]);
		}
		return { empty: false, value: changed ? elements : value, changed };
	}

	const objectNode = structuralObjectNode(node);
	if (objectNode?.props === undefined) return { empty: false, value, changed: false };
	const input = value as Record<string, unknown>;
	let changed = false;
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(input)) copy[key] = input[key];
	for (const prop of objectNode.props) {
		if (typeof prop.key !== "string" || !(prop.key in input)) continue;
		const propPath = pathJoin(path, prop.key);
		const normalized = normalizeField(prop.val, input[prop.key], propPath, refusals, depth + 1);
		if (normalized.empty) {
			delete copy[prop.key];
			changed = true;
		} else if (normalized.changed) {
			copy[prop.key] = normalized.value;
			changed = true;
		}
	}
	if (Object.keys(copy).length === 0) return { empty: true };
	return { empty: false, value: changed ? copy : value, changed };
}

interface NormalizeResult {
	args: unknown;
	changed: boolean;
	refusals: ElementRefusal[];
}

function normalizeArguments(rootNode: IrNode, args: unknown): NormalizeResult {
	const refusals: ElementRefusal[] = [];
	if (typeof args !== "object" || args === null || Array.isArray(args)) return { args, changed: false, refusals };
	const objectNode = structuralObjectNode(rootNode);
	if (objectNode?.props === undefined) return { args, changed: false, refusals };
	let changed = false;
	const input = args as Record<string, unknown>;
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(input)) copy[key] = input[key];
	for (const prop of objectNode.props) {
		if (typeof prop.key !== "string" || !(prop.key in input)) continue;
		const propPath = pathJoin("", prop.key);
		const normalized = normalizeField(prop.val, input[prop.key], propPath, refusals, 0);
		if (normalized.empty) {
			delete copy[prop.key];
			changed = true;
		} else if (normalized.changed) {
			copy[prop.key] = normalized.value;
			changed = true;
		}
	}
	return { args: changed ? copy : args, changed, refusals };
}

function truncateForError(value: unknown): unknown {
	if (typeof value === "string") return value.length > 256 ? `${value.slice(0, 256)}…` : value;
	if (Array.isArray(value)) return value.map(truncateForError);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) out[key] = truncateForError((value as Record<string, unknown>)[key]);
		return out;
	}
	return value;
}

function refuseEmptyElements(name: string, refusals: ElementRefusal[], originalArgs: unknown): never {
	const lines = refusals.map((refusal) => `  - ${refusal.path}[${refusal.index}]: array element must not be empty`);
	throw new Error(
		`Validation failed for tool "${name}":\n${lines.join("\n")}\n\nReceived arguments:\n${JSON.stringify(truncateForError(originalArgs), null, 2)}`,
	);
}

function stripUndeclaredRootKeys(rootNode: IrNode, args: unknown): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const objectNode = structuralObjectNode(rootNode);
	if (objectNode?.props === undefined) return args;
	if (objectNode.index !== undefined) return args;
	const declared = new Set<PropertyKey>();
	for (const prop of objectNode.props) declared.add(prop.key);
	const input = args as Record<string, unknown>;
	let stripped = false;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(input)) {
		if (declared.has(key)) {
			out[key] = input[key];
		} else {
			stripped = true;
		}
	}
	return stripped ? out : args;
}

function normalizeAndValidate(toolName: string, toolCallId: unknown, parameters: unknown, params: unknown): unknown {
	const originalArgs = params;
	const rootNode: IrNode | undefined = isEmbeddableSchema(parameters) ? parameters.ir : undefined;

	let current: unknown = params;
	if (rootNode !== undefined) {
		const initial = normalizeArguments(rootNode, params);
		if (initial.refusals.length > 0) refuseEmptyElements(toolName, initial.refusals, originalArgs);
		current = initial.args;
	}

	const id = typeof toolCallId === "string" ? toolCallId : "omomp";
	const seen = new Set<string>();
	for (;;) {
		const validated = validateToolArguments(
			{ name: toolName, description: "", parameters } as Parameters<typeof validateToolArguments>[0],
			{ type: "toolCall", id, name: toolName, arguments: current as Record<string, unknown> },
		);
		if (rootNode === undefined) return validated;
		const renormalized = normalizeArguments(rootNode, validated);
		if (renormalized.refusals.length > 0) refuseEmptyElements(toolName, renormalized.refusals, originalArgs);
		if (!renormalized.changed) {
			return stripUndeclaredRootKeys(rootNode, validated);
		}
		const key = JSON.stringify(renormalized.args);
		if (seen.has(key)) {
			return stripUndeclaredRootKeys(rootNode, validated);
		}
		seen.add(key);
		current = renormalized.args;
	}
}

interface OmompToolDefinitionShape {
	name: string;
	parameters: unknown;
	execute: unknown;
}

export function omompTool<D extends OmompToolDefinitionShape>(definition: D): D {
	const originalExecute = definition.execute as (toolCallId: unknown, params: unknown, ...rest: unknown[]) => unknown;
	const wrapped = {
		...definition,
		lenientArgValidation: true,
		execute(this: unknown, toolCallId: unknown, params: unknown, ...rest: unknown[]) {
			const normalized = normalizeAndValidate(definition.name, toolCallId, definition.parameters, params);
			return originalExecute.call(this, toolCallId, normalized, ...rest);
		},
	};
	return wrapped as D;
}
