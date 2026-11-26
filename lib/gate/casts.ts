import path from "node:path";
import { createScanner, type Node, type SourceFile, SyntaxKind } from "typescript/unstable/ast";
import {
	isAsExpression,
	isNoSubstitutionTemplateLiteral,
	isParenthesizedExpression,
	isRegularExpressionLiteral,
	isStatement,
	isStringLiteral,
	isTemplateHead,
	isTemplateMiddle,
	isTemplateTail,
	isTypeAssertion,
} from "typescript/unstable/ast/is";
import type { GateFailure } from "./model.ts";
import { lineOf, type TsProject } from "./ts-project.ts";

type ChainedCastFailure = Extract<GateFailure, { readonly kind: "unmarked-chained-cast" }>;

type Comment = { readonly start: number; readonly end: number; readonly line: number };

type Line = { readonly start: number; readonly text: string };

type Range = { readonly start: number; readonly end: number };

const SAFETY = /^SAFETY:\s*\S/;
const TEXT_LIMIT = 120;

function isCast(node: Node): boolean {
	return isAsExpression(node) || isTypeAssertion(node);
}

function skipParentheses(node: Node): Node {
	let current = node;
	while (isParenthesizedExpression(current)) current = current.expression;
	return current;
}

function castOperand(node: Node): Node | undefined {
	if (isAsExpression(node) || isTypeAssertion(node)) return skipParentheses(node.expression);
	return undefined;
}

function isChained(node: Node): boolean {
	const operand = castOperand(node);
	return operand !== undefined && isCast(operand);
}

function parentOutsideParentheses(node: Node): Node | undefined {
	let current: Node | undefined = node.parent;
	while (current !== undefined && isParenthesizedExpression(current)) current = current.parent;
	return current;
}

function consumedByCast(node: Node): boolean {
	const parent = parentOutsideParentheses(node);
	return parent !== undefined && castOperand(parent) === node;
}

function containingStatement(node: Node): Node | undefined {
	let current: Node | undefined = node.parent;
	while (current !== undefined) {
		if (isStatement(current)) return current;
		current = current.parent;
	}
	return undefined;
}

function lineTable(file: SourceFile): readonly Line[] {
	const starts = file.getLineStarts();
	return starts.map((start, index) => {
		const next = index + 1 < starts.length ? starts[index + 1] : undefined;
		return { start, text: file.text.slice(start, next ?? file.text.length) };
	});
}

function singleLineComments(file: SourceFile): readonly Comment[] {
	const scanner = createScanner(false, undefined, file.text);
	const comments: Comment[] = [];
	for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
		if (token !== SyntaxKind.SingleLineCommentTrivia) continue;
		const start = scanner.getTokenStart();
		comments.push({ start, end: scanner.getTokenEnd(), line: file.getLineAndCharacterOfPosition(start).line + 1 });
	}
	return comments;
}

function safetyReason(text: string): boolean {
	return SAFETY.test(text.trim());
}

function literalRange(node: Node, file: SourceFile): Range | undefined {
	const literal =
		isStringLiteral(node) ||
		isNoSubstitutionTemplateLiteral(node) ||
		isTemplateHead(node) ||
		isTemplateMiddle(node) ||
		isTemplateTail(node) ||
		isRegularExpressionLiteral(node);
	return literal ? { start: node.getStart(file), end: node.getEnd() } : undefined;
}

function insideLiteral(position: number, literals: readonly Range[]): boolean {
	return literals.some((range) => range.start <= position && position < range.end);
}

function trailingMarker(file: SourceFile, comments: readonly Comment[], literals: readonly Range[], line: number, from: number): boolean {
	return comments.some(
		(comment) =>
			comment.line === line &&
			comment.start >= from &&
			!insideLiteral(comment.start, literals) &&
			safetyReason(file.text.slice(comment.start + 2, comment.end)),
	);
}

function wholeLineMarker(lines: readonly Line[], comments: readonly Comment[], literals: readonly Range[], index: number): boolean {
	const line = lines[index];
	if (line === undefined) return false;
	const trimmed = line.text.trim();
	if (!trimmed.startsWith("//")) return false;
	const start = line.start + (line.text.length - line.text.trimStart().length);
	const comment = comments.find((candidate) => candidate.start === start);
	return comment !== undefined && !insideLiteral(start, literals) && safetyReason(trimmed.slice(2));
}

function marked(node: Node, file: SourceFile, lines: readonly Line[], comments: readonly Comment[], literals: readonly Range[]): boolean {
	const line = lineOf(node);
	if (trailingMarker(file, comments, literals, line, node.getStart(file))) return true;
	if (wholeLineMarker(lines, comments, literals, line - 2)) return true;
	const statement = containingStatement(node);
	return statement !== undefined && wholeLineMarker(lines, comments, literals, lineOf(statement) - 2);
}

function castText(node: Node, file: SourceFile): string {
	return node.getText(file).replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);
}

function fileFailures(file: SourceFile, relative: string): ChainedCastFailure[] {
	const lines = lineTable(file);
	const comments = singleLineComments(file);
	const literals: Range[] = [];
	const casts: Node[] = [];
	const visit = (node: Node): void => {
		const range = literalRange(node, file);
		if (range !== undefined) literals.push(range);
		if (isCast(node)) casts.push(node);
		node.forEachChild(visit);
	};
	file.forEachChild(visit);
	const failures: ChainedCastFailure[] = [];
	for (const node of casts) {
		if (!isChained(node) || consumedByCast(node) || marked(node, file, lines, comments, literals)) continue;
		failures.push({ kind: "unmarked-chained-cast", file: relative, line: lineOf(node), text: castText(node, file) });
	}
	return failures;
}

function compare(a: ChainedCastFailure, b: ChainedCastFailure): number {
	if (a.file !== b.file) return a.file < b.file ? -1 : 1;
	return a.line - b.line;
}

export async function checkChainedCasts(input: {
	readonly root: string;
	readonly production: readonly string[];
	readonly project: TsProject;
}): Promise<GateFailure[]> {
	const failures: ChainedCastFailure[] = [];
	for (const entry of input.production) {
		const absolute = path.resolve(input.root, entry);
		const file = await input.project.sourceFile(absolute);
		if (file === undefined) continue;
		const relative = path.relative(input.root, absolute).split(path.sep).join("/");
		failures.push(...fileFailures(file, relative));
	}
	failures.sort(compare);
	return failures;
}
