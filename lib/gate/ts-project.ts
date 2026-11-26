import { existsSync } from "node:fs";
import path from "node:path";
import { type Node, type SourceFile, SyntaxKind } from "typescript/unstable/ast";
import {
	isExportDeclaration,
	isExportSpecifier,
	isImportClause,
	isImportEqualsDeclaration,
	isImportSpecifier,
	isNamespaceExport,
	isNamespaceImport,
} from "typescript/unstable/ast/is";
import { API, type Checker, type Project, SignatureKind, SymbolFlags, type Symbol as TsSymbol } from "typescript/unstable/async";

export type ExportKind = "value" | "type";

export type ModuleExports = ReadonlyMap<string, ExportKind>;

export type DefaultExport =
	| { readonly kind: "callable" }
	| { readonly kind: "not-callable"; readonly reason: string }
	| { readonly kind: "absent" };

export type TsProject = {
	sourceFile(file: string): Promise<SourceFile | undefined>;
	exportsOfFile(file: string): Promise<ModuleExports | undefined>;
	exportsAt(moduleSpecifier: Node): Promise<ModuleExports | undefined>;
	defaultExport(file: string): Promise<DefaultExport>;
};

export type TsHost = {
	open(files: readonly string[]): Promise<TsProject>;
	close(): Promise<void>;
};

const ALIAS_DEPTH = 32;

export function lineOf(node: Node): number {
	const file = node.getSourceFile();
	return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function clauseTypeOnly(clause: Node): boolean {
	return isImportClause(clause) && clause.phaseModifier === SyntaxKind.TypeKeyword;
}

function declaredTypeOnly(node: Node): boolean {
	if (isExportSpecifier(node)) return node.isTypeOnly || (isExportDeclaration(node.parent.parent) && node.parent.parent.isTypeOnly);
	if (isImportSpecifier(node)) return node.isTypeOnly || clauseTypeOnly(node.parent.parent);
	if (isImportClause(node)) return clauseTypeOnly(node);
	if (isNamespaceImport(node)) return clauseTypeOnly(node.parent);
	if (isNamespaceExport(node)) return isExportDeclaration(node.parent) && node.parent.isTypeOnly;
	if (isExportDeclaration(node)) return node.isTypeOnly;
	if (isImportEqualsDeclaration(node)) return node.isTypeOnly;
	return false;
}

async function aliasTypeOnly(project: Project, symbol: TsSymbol): Promise<boolean> {
	for (const handle of symbol.declarations) {
		const node = await handle.resolve(project);
		if (node !== undefined && declaredTypeOnly(node)) return true;
	}
	return false;
}

async function exportKind(project: Project, checker: Checker, symbol: TsSymbol): Promise<ExportKind | undefined> {
	let current = symbol;
	for (let depth = 0; depth < ALIAS_DEPTH; depth++) {
		if (!(current.flags & SymbolFlags.Alias)) return current.flags & SymbolFlags.Value ? "value" : "type";
		if (await aliasTypeOnly(project, current)) return "type";
		const next = await checker.getImmediateAliasedSymbol(current);
		if (next === undefined) return undefined;
		current = next;
	}
	return undefined;
}

async function exportsOfModule(project: Project, module: TsSymbol): Promise<ModuleExports> {
	const result = new Map<string, ExportKind>();
	for (const symbol of await project.checker.getExportsOfModule(module)) {
		const kind = await exportKind(project, project.checker, symbol);
		if (kind !== undefined) result.set(symbol.name, kind);
	}
	return result;
}

function projectApi(project: Project): TsProject {
	const moduleOf = async (file: string): Promise<TsSymbol | undefined> => {
		const source = await project.program.getSourceFile(file);
		return source === undefined ? undefined : project.checker.getSymbolAtLocation(source);
	};
	return {
		sourceFile: (file) => project.program.getSourceFile(file),
		async exportsOfFile(file) {
			const module = await moduleOf(file);
			return module === undefined ? undefined : exportsOfModule(project, module);
		},
		async exportsAt(moduleSpecifier) {
			const module = await project.checker.getSymbolAtLocation(moduleSpecifier);
			return module === undefined ? undefined : exportsOfModule(project, module);
		},
		async defaultExport(file) {
			const module = await moduleOf(file);
			if (module === undefined) return { kind: "absent" };
			const symbol = (await project.checker.getExportsOfModule(module)).find((s) => s.name === "default");
			if (symbol === undefined) return { kind: "absent" };
			const target = symbol.flags & SymbolFlags.Alias ? await project.checker.getAliasedSymbol(symbol) : symbol;
			const type = await project.checker.getTypeOfSymbol(target);
			if (type === undefined) return { kind: "not-callable", reason: "the default export has no type" };
			const calls = await project.checker.getSignaturesOfType(type, SignatureKind.Call);
			if (calls.length > 0) return { kind: "callable" };
			return { kind: "not-callable", reason: `its type is ${await project.checker.typeToString(type)}` };
		},
	};
}

function configText(root: string, files: readonly string[]): string {
	const extended = existsSync(path.join(root, "tsconfig.json"));
	return JSON.stringify({
		...(extended ? { extends: "./tsconfig.json" } : {}),
		compilerOptions: {
			...(extended ? {} : { target: "esnext", module: "preserve", moduleResolution: "bundler", allowImportingTsExtensions: true, strict: true }),
			noEmit: true,
			skipLibCheck: true,
		},
		include: [],
		files,
	});
}

export function openTsHost(root: string): TsHost {
	const configs = new Map<string, string>();
	const api = new API({
		cwd: root,
		fs: {
			readFile: (file) => configs.get(file),
			fileExists: (file) => (configs.has(file) ? true : undefined),
		},
	});
	return {
		async open(files) {
			const config = path.join(root, `.omomp-gate-${configs.size}.tsconfig.json`);
			configs.set(config, configText(root, files));
			const snapshot = await api.updateSnapshot({ openProjects: [config] });
			const project = snapshot.getProject(config);
			if (project === undefined) throw new Error(`TypeScript opened no project for ${config}`);
			return projectApi(project);
		},
		close: () => api.close(),
	};
}
