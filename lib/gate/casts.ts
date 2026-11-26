import path from "node:path";
import { type Node, type SourceFile, SyntaxKind } from "typescript/unstable/ast";
import {
	isAsExpression,
	isClassDeclaration,
	isClassExpression,
	isParenthesizedExpression,
	isStatement,
	isTypeAssertion,
} from "typescript/unstable/ast/is";
import { type CommentKind, forEachLeadingCommentRange, forEachTrailingCommentRange } from "typescript/unstable/ast/scanner";
import type { GateFailure } from "./model.ts";
import { lineOf, type TsProject } from "./ts-project.ts";

type ChainedCastFailure = Extract<GateFailure, { readonly kind: "unmarked-chained-cast" }>;

type Comment = { readonly start: number; readonly end: number; readonly line: number };

type Line = { readonly start: number; readonly text: string };

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
		if (isStatement(current) || isClassDeclaration(current.parent) || isClassExpression(current.parent)) return current;
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

function safetyReason(text: string): boolean {
	return SAFETY.test(text.trim());
}

function trailingMarker(file: SourceFile, comments: readonly Comment[], line: number, from: number): boolean {
	return comments.some(
		(comment) => comment.line === line && comment.start >= from && safetyReason(file.text.slice(comment.start + 2, comment.end)),
	);
}

function wholeLineMarker(lines: readonly Line[], comments: readonly Comment[], index: number): boolean {
	const line = lines[index];
	if (line === undefined) return false;
	const trimmed = line.text.trim();
	if (!trimmed.startsWith("//")) return false;
	const start = line.start + (line.text.length - line.text.trimStart().length);
	return comments.some((candidate) => candidate.start === start) && safetyReason(trimmed.slice(2));
}

function marked(node: Node, file: SourceFile, lines: readonly Line[], comments: readonly Comment[]): boolean {
	const line = lineOf(node);
	if (trailingMarker(file, comments, line, node.getStart(file))) return true;
	if (wholeLineMarker(lines, comments, line - 2)) return true;
	const statement = containingStatement(node);
	return statement !== undefined && wholeLineMarker(lines, comments, lineOf(statement) - 2);
}

function castText(node: Node, file: SourceFile): string {
	return node.getText(file).replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);
}

function fileFailures(file: SourceFile, relative: string): ChainedCastFailure[] {
	const lines = lineTable(file);
	const comments = new Map<number, Comment>();
	const record = (start: number, end: number, kind: CommentKind): undefined => {
		if (kind === SyntaxKind.SingleLineCommentTrivia && !comments.has(start)) {
			comments.set(start, { start, end, line: file.getLineAndCharacterOfPosition(start).line + 1 });
		}
		return undefined;
	};
	const casts: Node[] = [];
	const visit = (node: Node): void => {
		forEachLeadingCommentRange(file.text, node.pos, record);
		forEachTrailingCommentRange(file.text, node.end, record);
		if (isCast(node)) casts.push(node);
		node.forEachChild(visit);
	};
	file.forEachChild(visit);
	const found = [...comments.values()];
	const failures: ChainedCastFailure[] = [];
	for (const node of casts) {
		if (!isChained(node) || consumedByCast(node) || marked(node, file, lines, found)) continue;
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
