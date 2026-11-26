export type GateProblem = {
	readonly file: string;
	readonly line: number;
	readonly construction: "registerTool" | "customTools";
	readonly detail: string;
};

type Token = {
	readonly kind: "identifier" | "literal" | "punct";
	readonly text: string;
	readonly line: number;
};

const OPENERS: Readonly<Record<string, true>> = { "(": true, "[": true, "{": true };
const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

function skipLineComment(text: string, start: number): number {
	const end = text.indexOf("\n", start);
	return end === -1 ? text.length : end;
}

function skipBlockComment(text: string, start: number): number {
	const end = text.indexOf("*/", start + 2);
	return end === -1 ? text.length : end + 2;
}

function skipQuoted(text: string, start: number): number {
	const quote = text.charAt(start);
	let index = start + 1;
	while (index < text.length) {
		const char = text.charAt(index);
		if (char === "\\") index += 2;
		else if (char === quote) return index + 1;
		else index += 1;
	}
	return index;
}

function skipBraces(text: string, start: number): number {
	let depth = 0;
	let index = start;
	while (index < text.length) {
		const char = text.charAt(index);
		const next = text.charAt(index + 1);
		if (char === "/" && next === "/") index = skipLineComment(text, index);
		else if (char === "/" && next === "*") index = skipBlockComment(text, index);
		else if (char === '"' || char === "'") index = skipQuoted(text, index);
		else if (char === "`") index = skipTemplate(text, index);
		else if (char === "{") {
			depth += 1;
			index += 1;
		} else if (char === "}") {
			depth -= 1;
			index += 1;
			if (depth === 0) return index;
		} else index += 1;
	}
	return index;
}

function skipTemplate(text: string, start: number): number {
	let index = start + 1;
	while (index < text.length) {
		const char = text.charAt(index);
		if (char === "\\") index += 2;
		else if (char === "`") return index + 1;
		else if (char === "$" && text.charAt(index + 1) === "{") index = skipBraces(text, index + 1);
		else index += 1;
	}
	return index;
}

function skipRegex(text: string, start: number): number {
	let index = start + 1;
	let inClass = false;
	while (index < text.length) {
		const char = text.charAt(index);
		if (char === "\\") index += 2;
		else if (char === "[") {
			inClass = true;
			index += 1;
		} else if (char === "]") {
			inClass = false;
			index += 1;
		} else if (char === "/" && !inClass) {
			index += 1;
			while (index < text.length && /[a-z]/.test(text.charAt(index))) index += 1;
			return index;
		} else if (char === "\n") return index;
		else index += 1;
	}
	return index;
}

function regexAllowedAfter(token: Token | undefined): boolean {
	if (token === undefined) return true;
	if (token.kind === "literal") return false;
	if (token.kind === "identifier") {
		return ["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "else", "do", "yield", "await"].includes(token.text);
	}
	return ![")", "]", "}"].includes(token.text);
}

export function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let line = 1;
	let index = 0;
	while (index < text.length) {
		const char = text.charAt(index);
		if (char === "\n") {
			line += 1;
			index += 1;
		} else if (char === " " || char === "\t" || char === "\r") {
			index += 1;
		} else if (char === "/" && text.charAt(index + 1) === "/") {
			index = skipLineComment(text, index);
		} else if (char === "/" && text.charAt(index + 1) === "*") {
			const end = skipBlockComment(text, index);
			for (let cursor = index; cursor < end; cursor += 1) if (text.charAt(cursor) === "\n") line += 1;
			index = end;
		} else if (char === '"' || char === "'") {
			const end = skipQuoted(text, index);
			tokens.push({ kind: "literal", text: text.slice(index, end), line });
			index = end;
		} else if (char === "`") {
			const end = skipTemplate(text, index);
			for (let cursor = index; cursor < end; cursor += 1) if (text.charAt(cursor) === "\n") line += 1;
			tokens.push({ kind: "literal", text: text.slice(index, end), line });
			index = end;
		} else if (char === "/" && regexAllowedAfter(tokens[tokens.length - 1])) {
			const end = skipRegex(text, index);
			tokens.push({ kind: "literal", text: text.slice(index, end), line });
			index = end;
		} else if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(text.charAt(index + 1)))) {
			let end = index + 1;
			while (end < text.length && /[A-Za-z0-9_.]/.test(text.charAt(end))) end += 1;
			tokens.push({ kind: "literal", text: text.slice(index, end), line });
			index = end;
		} else if (/[A-Za-z_$]/.test(char)) {
			let end = index + 1;
			while (end < text.length && /[A-Za-z0-9_$]/.test(text.charAt(end))) end += 1;
			tokens.push({ kind: "identifier", text: text.slice(index, end), line });
			index = end;
		} else {
			tokens.push({ kind: "punct", text: char, line });
			index += 1;
		}
	}
	return tokens;
}

function textOf(tokens: Token[], index: number): string | undefined {
	return tokens[index]?.text;
}

function matchClose(tokens: Token[], openIndex: number): number {
	const stack: string[] = [];
	for (let index = openIndex; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined || token.kind !== "punct") continue;
		if (OPENERS[token.text] === true) stack.push(token.text);
		else if (CLOSERS[token.text] !== undefined) {
			if (stack[stack.length - 1] === CLOSERS[token.text]) stack.pop();
			if (stack.length === 0) return index;
		}
	}
	return tokens.length;
}

function scanAngles(tokens: Token[], start: number): number | undefined {
	let depth = 0;
	let index = start;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === undefined) return undefined;
		if (token.kind === "punct" && token.text === "<") depth += 1;
		else if (token.kind === "punct" && token.text === ">" && textOf(tokens, index - 1) !== "=") {
			depth -= 1;
			if (depth === 0) return index;
		} else if (token.kind === "punct" && depth > 0 && (token.text === ";" || token.text === "{")) return undefined;
		index += 1;
	}
	return undefined;
}

function callOpenParen(tokens: Token[], nameIndex: number): number | undefined {
	let cursor = nameIndex + 1;
	if (textOf(tokens, cursor) === "<") {
		const close = scanAngles(tokens, cursor);
		if (close === undefined) return undefined;
		cursor = close + 1;
	}
	return textOf(tokens, cursor) === "(" ? cursor : undefined;
}

function findFirstArgEnd(tokens: Token[], start: number, close: number): number {
	const stack: string[] = [];
	for (let index = start; index < close; index += 1) {
		const token = tokens[index];
		if (token === undefined || token.kind !== "punct") continue;
		if (OPENERS[token.text] === true) stack.push(token.text);
		else if (CLOSERS[token.text] !== undefined) {
			if (stack[stack.length - 1] === CLOSERS[token.text]) stack.pop();
		} else if (token.text === "," && stack.length === 0) return index;
	}
	return close;
}

function exactOmompToolCall(tokens: Token[], start: number, end: number): boolean {
	const head = tokens[start];
	if (head === undefined || head.kind !== "identifier" || head.text !== "omompTool") return false;
	const open = callOpenParen(tokens, start);
	if (open === undefined || open >= end) return false;
	return matchClose(tokens, open) === end - 1;
}

function firstArgIsOmompToolCall(tokens: Token[], open: number, close: number): boolean {
	const end = findFirstArgEnd(tokens, open + 1, close);
	return exactOmompToolCall(tokens, open + 1, end);
}

function arrayElementsAreOmompToolCalls(tokens: Token[], open: number, close: number): boolean {
	let elementStart = open + 1;
	const stack: string[] = [];
	let index = open + 1;
	for (;;) {
		const token = tokens[index];
		const atEnd = index >= close;
		const atComma = !atEnd && token !== undefined && token.kind === "punct" && token.text === "," && stack.length === 0;
		if (atEnd || atComma) {
			if (elementStart < index && !exactOmompToolCall(tokens, elementStart, index)) return false;
			if (atEnd) return true;
			elementStart = index + 1;
		} else if (token !== undefined && token.kind === "punct") {
			if (OPENERS[token.text] === true) stack.push(token.text);
			else if (CLOSERS[token.text] !== undefined && stack[stack.length - 1] === CLOSERS[token.text]) stack.pop();
		}
		index += 1;
	}
}

function skipInterface(tokens: Token[], start: number): number {
	let index = start + 2;
	while (index < tokens.length && textOf(tokens, index) !== "{") {
		if (textOf(tokens, index) === ";") return index + 1;
		index += 1;
	}
	if (index >= tokens.length) return index;
	return matchClose(tokens, index) + 1;
}

function typeAliasEndsBefore(token: Token, depth: number): boolean {
	if (depth > 0 || token.kind !== "identifier") return false;
	return ["const", "let", "var", "function", "class", "return", "if", "export"].includes(token.text);
}

function skipTypeAlias(tokens: Token[], start: number): number {
	const stack: string[] = [];
	let index = start + 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === undefined) return index;
		if (token.kind === "punct") {
			if (OPENERS[token.text] === true) stack.push(token.text);
			else if (CLOSERS[token.text] !== undefined) {
				if (stack[stack.length - 1] !== CLOSERS[token.text]) return index;
				stack.pop();
				index += 1;
				continue;
			} else if (token.text === ";" && stack.length === 0) return index + 1;
		}
		if (typeAliasEndsBefore(token, stack.length)) return index;
		index += 1;
	}
	return index;
}

function skipDeclare(tokens: Token[], start: number): number {
	const stack: string[] = [];
	let index = start + 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === undefined) return index;
		if (token.kind === "punct") {
			if (OPENERS[token.text] === true) {
				if (token.text === "{" && stack.length === 0) return matchClose(tokens, index) + 1;
				stack.push(token.text);
			} else if (CLOSERS[token.text] !== undefined) {
				if (stack[stack.length - 1] === CLOSERS[token.text]) stack.pop();
			} else if (token.text === ";" && stack.length === 0) return index + 1;
		}
		index += 1;
	}
	return index;
}

function followedByTypeBody(tokens: Token[], close: number): boolean {
	const next = tokens[close + 1];
	const closer = tokens[close];
	if (next === undefined || closer === undefined || next.kind !== "punct") return false;
	if (next.text === "{" && next.line === closer.line) return true;
	if (next.text !== ":") return false;
	const stack: string[] = [];
	for (let index = close + 2; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined || token.kind !== "punct") continue;
		if (OPENERS[token.text] === true) {
			if (token.text === "{" && stack.length === 0) return true;
			stack.push(token.text);
		} else if (CLOSERS[token.text] !== undefined) {
			if (stack.length === 0) return false;
			if (stack[stack.length - 1] === CLOSERS[token.text]) stack.pop();
		} else if ((token.text === ";" || token.text === "=" || token.text === ",") && stack.length === 0) {
			return false;
		}
	}
	return false;
}

function isRegisterToolDeclaration(tokens: Token[], open: number): boolean {
	const close = matchClose(tokens, open);
	if (close >= tokens.length) return false;
	return followedByTypeBody(tokens, close);
}

export function isProductionSource(file: string): boolean {
	const normalized = file.replaceAll("\\", "/");
	if (normalized.endsWith(".d.ts")) return false;
	const segments = normalized.split("/");
	const base = segments[segments.length - 1] ?? "";
	if (
		base.endsWith(".test.ts") ||
		base.endsWith(".test.tsx") ||
		base.endsWith(".test.mts") ||
		base.endsWith(".test.cts") ||
		base.endsWith(".spec.ts") ||
		base.endsWith(".spec.tsx")
	) {
		return false;
	}
	return !segments.some((segment) => segment === "test" || segment === "tests" || segment === "__tests__" || segment === "node_modules");
}

const OMOMP_HINT = "wrap the definition in a direct omompTool(...) call from the shared src/tool-entry.ts";

function customToolsValueProblem(tokens: Token[], valueStart: number): string | undefined {
	if (textOf(tokens, valueStart) !== "[") return `customTools value is not an array literal; ${OMOMP_HINT}`;
	const close = matchClose(tokens, valueStart);
	if (arrayElementsAreOmompToolCalls(tokens, valueStart, close)) return undefined;
	return `customTools element is not a direct omompTool(...) call; ${OMOMP_HINT}`;
}

function assignmentValueStart(tokens: Token[], index: number): number | undefined {
	const first = textOf(tokens, index);
	if (first === "=") {
		const next = textOf(tokens, index + 1);
		return next === "=" || next === ">" ? undefined : index + 1;
	}
	const compound = first === "?" || first === "|" || first === "&";
	if (compound && textOf(tokens, index + 1) === first && textOf(tokens, index + 2) === "=") return index + 3;
	return undefined;
}

function enclosingClose(tokens: Token[], start: number): number | undefined {
	let depth = 0;
	for (let index = start; index < tokens.length; index++) {
		const text = textOf(tokens, index);
		if (text === undefined) return undefined;
		if (OPENERS[text] === true) depth += 1;
		else if (CLOSERS[text] !== undefined) {
			if (depth === 0) return index;
			depth -= 1;
		}
	}
	return undefined;
}

function enclosingOpen(tokens: Token[], start: number): number | undefined {
	let depth = 0;
	for (let index = start; index >= 0; index--) {
		const text = textOf(tokens, index);
		if (text === undefined) return undefined;
		if (CLOSERS[text] !== undefined) depth += 1;
		else if (OPENERS[text] === true) {
			if (depth === 0) return index;
			depth -= 1;
		}
	}
	return undefined;
}

function isParameterList(tokens: Token[], open: number): boolean {
	if (textOf(tokens, open) !== "(") return false;
	const close = matchClose(tokens, open);
	const after = textOf(tokens, close + 1);
	return after === "{" || after === ":" || (after === "=" && textOf(tokens, close + 2) === ">");
}

function isTypeObject(tokens: Token[], open: number): boolean {
	const before = textOf(tokens, open - 1);
	if (before === "as" || before === "satisfies" || before === "|" || before === "&" || before === "<") return true;
	return before === ":" && textOf(tokens, open - 2) === ")";
}

function isNotValueObject(tokens: Token[], open: number, close: number): boolean {
	const before = textOf(tokens, open - 1);
	if (before === "import" || before === "export" || textOf(tokens, close + 1) === "from") return true;
	if (isTypeObject(tokens, open)) return true;
	if (before === "?") return false;
	const outer = enclosingOpen(tokens, open - 1);
	if (outer !== undefined && (before === "(" || before === "," || before === ":") && isParameterList(tokens, outer)) return true;
	const next = textOf(tokens, close + 1);
	if (next === ":" || next === "of" || next === "in") return true;
	return next === "=" && assignmentValueStart(tokens, close + 1) !== undefined;
}

function customToolsProblem(tokens: Token[], index: number): string | undefined {
	const token = tokens[index];
	const previous = textOf(tokens, index - 1);
	const next = textOf(tokens, index + 1);
	if (token?.kind === "literal" && previous === "[" && next === "]") {
		const valueStart = assignmentValueStart(tokens, index + 2);
		return valueStart === undefined ? undefined : customToolsValueProblem(tokens, valueStart);
	}
	if (token?.kind === "literal" && next !== ":") return undefined;
	if (previous === ".") {
		const valueStart = assignmentValueStart(tokens, index + 1);
		return valueStart === undefined ? undefined : customToolsValueProblem(tokens, valueStart);
	}
	const shorthand = (previous === "{" || previous === ",") && (next === "," || next === "}");
	if (next !== ":" && !shorthand) return undefined;
	const open = enclosingOpen(tokens, index - 1);
	const close = enclosingClose(tokens, index + 1);
	if (open === undefined || close === undefined || textOf(tokens, open) !== "{" || textOf(tokens, close) !== "}") {
		return undefined;
	}
	if (isNotValueObject(tokens, open, close)) return undefined;
	if (next === ":") return customToolsValueProblem(tokens, index + 2);
	return `customTools shorthand hides the value from the check; write customTools: [omompTool(...), ...] or ${OMOMP_HINT}`;
}

export function toolEntryGateProblems(file: string, text: string): GateProblem[] {
	if (!isProductionSource(file)) return [];
	const problems: GateProblem[] = [];
	const tokens = tokenize(text);
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === undefined) break;
		if (token.kind === "identifier" && token.text === "declare") {
			index = skipDeclare(tokens, index);
			continue;
		}
		if (
			token.kind === "identifier" &&
			token.text === "interface" &&
			tokens[index + 1]?.kind === "identifier" &&
			(textOf(tokens, index + 2) === "{" || textOf(tokens, index + 2) === "extends" || textOf(tokens, index + 2) === "<")
		) {
			index = skipInterface(tokens, index);
			continue;
		}
		if (
			token.kind === "identifier" &&
			token.text === "type" &&
			tokens[index + 1]?.kind === "identifier" &&
			(textOf(tokens, index + 2) === "=" || textOf(tokens, index + 2) === "<")
		) {
			index = skipTypeAlias(tokens, index);
			continue;
		}
		if (token.kind === "identifier" && token.text === "registerTool" && textOf(tokens, index + 1) !== ":") {
			const open = callOpenParen(tokens, index);
			if (open !== undefined && !isRegisterToolDeclaration(tokens, open)) {
				const close = matchClose(tokens, open);
				if (!firstArgIsOmompToolCall(tokens, open, close)) {
					problems.push({
						file,
						line: token.line,
						construction: "registerTool",
						detail: `registerTool argument is not a direct omompTool(...) call; ${OMOMP_HINT}`,
					});
				}
			}
		}
		if (
			(token.kind === "identifier" && token.text === "customTools") ||
			(token.kind === "literal" && (token.text === '"customTools"' || token.text === "'customTools'"))
		) {
			const detail = customToolsProblem(tokens, index);
			if (detail !== undefined) problems.push({ file, line: token.line, construction: "customTools", detail });
		}
		index += 1;
	}
	return problems;
}

export function describeGateProblem(problem: GateProblem): string {
	return `${problem.file}:${problem.line} hands a tool definition to the host through ${problem.construction} without the shared registration entry: ${problem.detail}`;
}
