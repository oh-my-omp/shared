import path from "node:path";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { SyntaxKind } from "typescript/unstable/ast";
import {
	isCallExpression,
	isExportDeclaration,
	isExternalModuleReference,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isStringLiteral,
} from "typescript/unstable/ast/is";
import type { GateFailure, GatedShape, ImportSite } from "./model";
import { lineOf, type TsProject } from "./ts-project";

type Input = {
	readonly root: string;
	readonly shape: Extract<GatedShape, { readonly kind: "plugin-multi" | "config-bundle" }>;
	readonly production: readonly string[];
	readonly project: TsProject;
};

type CrossExtensionFailure = Extract<GateFailure, { readonly kind: "cross-extension-import" }>;

type ProductionFile = { readonly absolute: string; readonly file: string };

const EXTENSION_PREFIXES: readonly string[] = ["agent/extensions", "agent/extensions-last"];

function toPosix(file: string): string {
	return file.split(path.sep).join("/");
}

function relativeTo(root: string, file: string): string {
	return toPosix(path.relative(root, file));
}

function isSharedPath(file: string): boolean {
	for (const directory of ["agent/extensions/_shared", "extensions/_shared"]) {
		if (file === directory || file.startsWith(`${directory}/`)) return true;
	}
	return file.split("/").includes("omomp-shared");
}

function bundleExtensionDirectory(file: string): string | undefined {
	for (const prefix of EXTENSION_PREFIXES) {
		if (!file.startsWith(`${prefix}/`)) continue;
		const rest = file.slice(prefix.length + 1);
		const slash = rest.indexOf("/");
		if (slash <= 0) return undefined;
		const name = rest.slice(0, slash);
		if (name === "_shared") return undefined;
		const directory = `${prefix}/${name}`;
		return isSharedPath(directory) ? undefined : directory;
	}
	return undefined;
}

function extensionDirectories(shape: Input["shape"], files: readonly string[]): readonly string[] {
	const directories = new Set<string>();
	if (shape.kind === "plugin-multi") {
		for (const entry of shape.entries) {
			const directory = path.posix.dirname(path.posix.normalize(entry));
			if (!isSharedPath(directory)) directories.add(directory);
		}
		return [...directories];
	}
	for (const file of files) {
		const directory = bundleExtensionDirectory(file);
		if (directory !== undefined) directories.add(directory);
	}
	return [...directories];
}

function contains(directory: string, file: string): boolean {
	const relative = path.posix.relative(directory, file);
	return relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative));
}

function ownerOf(file: string, directories: readonly string[]): string | undefined {
	let owner: string | undefined;
	for (const directory of directories) {
		if (contains(directory, file) && (owner === undefined || directory.length > owner.length)) owner = directory;
	}
	return owner;
}

function moduleSpecifierOf(node: Node): Node | undefined {
	if (isImportDeclaration(node)) return node.moduleSpecifier;
	if (isExportDeclaration(node)) return node.moduleSpecifier;
	if (isImportEqualsDeclaration(node)) {
		return isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : undefined;
	}
	if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) return node.arguments[0];
	return undefined;
}

function relativeImports(source: SourceFile, file: string): readonly ImportSite[] {
	const found: ImportSite[] = [];
	const visit = (node: Node): void => {
		const specifier = moduleSpecifierOf(node);
		if (specifier !== undefined && isStringLiteral(specifier) && specifier.text.startsWith(".")) {
			found.push({ file, line: lineOf(node), specifier: specifier.text });
		}
		node.forEachChild(visit);
	};
	visit(source);
	return found;
}

function compareFailures(a: CrossExtensionFailure, b: CrossExtensionFailure): number {
	if (a.site.file !== b.site.file) return a.site.file < b.site.file ? -1 : 1;
	return a.site.line - b.site.line;
}

export async function checkCrossExtensionImports(input: Input): Promise<GateFailure[]> {
	const files: readonly ProductionFile[] = input.production.map((absolute) => ({
		absolute,
		file: relativeTo(input.root, absolute),
	}));
	const directories = extensionDirectories(
		input.shape,
		files.map((file) => file.file),
	);
	const failures: CrossExtensionFailure[] = [];
	for (const { absolute, file } of files) {
		const from = ownerOf(file, directories);
		if (from === undefined) continue;
		const source = await input.project.sourceFile(absolute);
		if (source === undefined) throw new Error(`${file} is in the production set but not in the TypeScript project`);
		for (const site of relativeImports(source, file)) {
			const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), site.specifier));
			const to = isSharedPath(target) ? undefined : ownerOf(target, directories);
			if (to === undefined || to === from) continue;
			failures.push({ kind: "cross-extension-import", site, from, to });
		}
	}
	return failures.sort(compareFailures);
}
