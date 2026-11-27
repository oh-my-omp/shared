import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { type Node, SyntaxKind } from "typescript/unstable/ast";
import {
	isCallExpression,
	isExportDeclaration,
	isExternalModuleReference,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isNamedExports,
	isNamedImports,
	isNamespaceExport,
	isNamespaceImport,
	isStringLiteral,
} from "typescript/unstable/ast/is";
import { DEPENDENCY_SECTIONS, type Manifest } from "../deps.ts";
import type { ImportSite, SourceSet, UpstreamFailure } from "./model.ts";
import { lineOf, type TsHost, type TsProject } from "./ts-project.ts";

const HOST_SCOPE = "@oh-my-pi/";
const CODING_AGENT = "@oh-my-pi/pi-coding-agent";
const BUNDLED_PACKAGES: Record<string, true> = {
	"@oh-my-pi/pi-agent-core": true,
	"@oh-my-pi/pi-ai": true,
	"@oh-my-pi/pi-catalog": true,
	"@oh-my-pi/pi-coding-agent": true,
	"@oh-my-pi/pi-natives": true,
	"@oh-my-pi/pi-tui": true,
	"@oh-my-pi/pi-utils": true,
};
const DECLARATION_SUFFIXES: Record<string, string> = { ".js": ".d.ts", ".mjs": ".d.mts", ".cjs": ".d.cts" };
const LEGACY_MODULE_SCRIPT = path.join("scripts", "legacy-pi-virtual-module.ts");

type Site = {
	readonly file: string;
	readonly line: number;
	readonly specifier: string;
	readonly index: number;
	readonly valueNames: readonly string[];
	readonly typeNames: readonly string[];
	readonly value: boolean;
	readonly moduleSpecifier: Node;
};

type SiteParts = Omit<Site, "file" | "line" | "index">;

type Table = ReadonlyMap<string, string>;

type TableLoad =
	| { readonly ok: true; readonly table: Table; readonly piManifest: string }
	| { readonly ok: false; readonly reason: string };

type Resolution = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

export async function checkUpstreamExports(input: {
	readonly root: string;
	readonly manifest: Manifest | undefined;
	readonly sources: SourceSet;
	readonly host: TsHost;
}): Promise<{ readonly failures: UpstreamFailure[]; readonly nonProduction: UpstreamFailure[] }> {
	const { root, manifest, host } = input;
	const sources: SourceSet = {
		production: input.sources.production.map((file) => path.join(root, file)),
		nonProduction: input.sources.nonProduction.map((file) => path.join(root, file)),
		tests: input.sources.tests,
	};
	const project = await host.open([...sources.production, ...sources.nonProduction]);
	const productionSites = await collectSites(root, project, sources.production);
	const otherSites = await collectSites(root, project, sources.nonProduction);
	const failures: UpstreamFailure[] = [];
	const nonProduction: UpstreamFailure[] = [];
	const targets = new Map<string, string>();
	if (productionSites.some((site) => site.value) || otherSites.some((site) => site.value)) {
		const loaded = await loadModuleTable(root);
		if (!loaded.ok) return { failures: [{ kind: "module-table-unavailable", reason: loaded.reason }], nonProduction: [] };
		classifyValueSites(productionSites, loaded.table, loaded.piManifest, manifest, root, failures, targets);
		classifyValueSites(otherSites, loaded.table, loaded.piManifest, manifest, root, nonProduction);
	}
	await checkSymbols({ root, project, host, productionSites, targets, failures });
	return {
		failures: failures.sort(compareFailures),
		nonProduction: nonProduction.sort(compareFailures),
	};
}

function classifyValueSites(
	sites: readonly Site[],
	table: Table,
	piManifest: string,
	manifest: Manifest | undefined,
	root: string,
	bucket: UpstreamFailure[],
	targets?: Map<string, string>,
): void {
	const rootManifest = path.join(root, "package.json");
	for (const site of sites) {
		if (!site.value) continue;
		const [scope, name] = site.specifier.split("/");
		const packageName = name === undefined ? site.specifier : `${scope}/${name}`;
		if (BUNDLED_PACKAGES[packageName] === true) {
			const importSpecifier = table.get(site.specifier);
			if (importSpecifier === undefined) {
				bucket.push({ kind: "unbundled-subpath", site: importSite(site), package: packageName });
				continue;
			}
			const resolved = resolveTarget(importSpecifier, piManifest, root);
			if (!resolved.ok) {
				bucket.push({ kind: "unresolved-target", site: importSite(site), reason: resolved.reason });
				continue;
			}
			if (!existsSync(resolved.path)) {
				bucket.push({ kind: "unresolved-target", site: importSite(site), reason: `${resolved.path} does not exist on disk` });
				continue;
			}
			targets?.set(siteKey(site), declarationOf(resolved.path));
			continue;
		}
		if (!declared(manifest, packageName)) {
			bucket.push({ kind: "undeclared-package", site: importSite(site), package: packageName });
			continue;
		}
		const resolved = resolveSpecifier(site.specifier, rootManifest, root);
		if (!resolved.ok) {
			bucket.push({ kind: "unresolved-target", site: importSite(site), reason: resolved.reason });
			continue;
		}
		if (!existsSync(resolved.path)) {
			bucket.push({ kind: "unresolved-target", site: importSite(site), reason: `${resolved.path} does not exist on disk` });
			continue;
		}
		targets?.set(siteKey(site), declarationOf(resolved.path));
	}
}

async function checkSymbols(input: {
	readonly root: string;
	readonly project: TsProject;
	readonly host: TsHost;
	readonly productionSites: readonly Site[];
	readonly targets: ReadonlyMap<string, string>;
	readonly failures: UpstreamFailure[];
}): Promise<void> {
	const hostProject = input.targets.size === 0 ? undefined : await input.host.open([...new Set(input.targets.values())], "host");
	for (const site of input.productionSites) {
		const target = input.targets.get(siteKey(site));
		if (site.valueNames.length > 0 && target !== undefined && hostProject !== undefined) {
			const exports = await hostProject.exportsOfFile(target);
			if (exports === undefined) {
				input.failures.push({ kind: "unresolved-target", site: importSite(site), reason: `TypeScript resolved no module for ${target}` });
			} else {
				const targetText = displayPath(input.root, target);
				for (const symbol of site.valueNames) {
					const kind = exports.get(symbol);
					if (kind === undefined) input.failures.push({ kind: "missing-export", site: importSite(site), symbol, target: targetText });
					else if (kind === "type") input.failures.push({ kind: "type-only-export", site: importSite(site), symbol, target: targetText });
				}
			}
		}
		if (site.typeNames.length === 0) continue;
		const exports = await input.project.exportsAt(site.moduleSpecifier);
		if (exports === undefined) {
			input.failures.push({
				kind: "unresolved-target",
				site: importSite(site),
				reason: `TypeScript resolved no module for '${site.specifier}'`,
			});
			continue;
		}
		for (const symbol of site.typeNames) {
			if (!exports.has(symbol))
				input.failures.push({ kind: "missing-type-export", site: importSite(site), symbol, target: site.specifier });
		}
	}
}

function displayPath(root: string, file: string): string {
	const relative = relativePosix(root, file);
	return relative.startsWith("../") ? file : relative;
}

async function loadModuleTable(root: string): Promise<TableLoad> {
	const located = resolveSpecifier(`${CODING_AGENT}/package.json`, path.join(root, "package.json"), root);
	if (!located.ok) return { ok: false, reason: `cannot resolve ${CODING_AGENT}/package.json from ${root}: ${located.reason}` };
	const piManifest = located.path;
	const script = path.join(path.dirname(piManifest), LEGACY_MODULE_SCRIPT);
	let loaded: unknown;
	try {
		loaded = await import(script);
	} catch (error) {
		return { ok: false, reason: `${script} cannot be imported: ${messageOf(error)}` };
	}
	if (!isRecord(loaded) || typeof loaded.collectBundledPiEntries !== "function") {
		return { ok: false, reason: `${script} exports no collectBundledPiEntries function` };
	}
	let raw: unknown;
	try {
		raw = await loaded.collectBundledPiEntries();
	} catch (error) {
		return { ok: false, reason: `${script} collectBundledPiEntries() failed: ${messageOf(error)}` };
	}
	if (!Array.isArray(raw)) return { ok: false, reason: "collectBundledPiEntries() did not return an array" };
	const entries = new Map<string, string>();
	for (const item of raw) {
		if (!isRecord(item) || typeof item.key !== "string" || typeof item.importSpecifier !== "string") {
			return { ok: false, reason: "collectBundledPiEntries() returned a malformed entry" };
		}
		entries.set(item.key, item.importSpecifier);
	}
	return { ok: true, table: entries, piManifest };
}

async function collectSites(root: string, project: TsProject, files: readonly string[]): Promise<Site[]> {
	const sites: Site[] = [];
	for (const file of files) {
		const source = await project.sourceFile(file);
		if (source === undefined) continue;
		let index = 0;
		const visit = (node: Node): void => {
			const parts = siteParts(node);
			if (parts !== undefined) {
				sites.push({ ...parts, file: relativePosix(root, file), line: lineOf(node), index });
				index++;
			}
			node.forEachChild(visit);
		};
		visit(source);
	}
	return sites;
}

function siteParts(node: Node): SiteParts | undefined {
	if (isImportDeclaration(node)) {
		const host = hostSpecifier(node.moduleSpecifier);
		if (host === undefined) return undefined;
		const clause = node.importClause;
		const valueNames: string[] = [];
		const typeNames: string[] = [];
		let value = false;
		if (clause === undefined) {
			value = true;
		} else {
			const clauseTypeOnly = clause.phaseModifier === SyntaxKind.TypeKeyword;
			if (clause.name !== undefined) {
				if (clauseTypeOnly) typeNames.push("default");
				else {
					valueNames.push("default");
					value = true;
				}
			}
			const bindings = clause.namedBindings;
			if (bindings !== undefined) {
				if (isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						const name = (element.propertyName ?? element.name).text;
						if (clauseTypeOnly || element.isTypeOnly) typeNames.push(name);
						else {
							valueNames.push(name);
							value = true;
						}
					}
				} else if (isNamespaceImport(bindings) && !clauseTypeOnly) {
					value = true;
				}
			}
		}
		return { specifier: host.specifier, valueNames, typeNames, value, moduleSpecifier: host.node };
	}
	if (isImportEqualsDeclaration(node)) {
		if (node.isTypeOnly || !isExternalModuleReference(node.moduleReference)) return undefined;
		const host = hostSpecifier(node.moduleReference.expression);
		if (host === undefined) return undefined;
		return { specifier: host.specifier, valueNames: [], typeNames: [], value: true, moduleSpecifier: host.node };
	}
	if (isExportDeclaration(node)) {
		const host = hostSpecifier(node.moduleSpecifier);
		if (host === undefined) return undefined;
		const clause = node.exportClause;
		if (clause === undefined || isNamespaceExport(clause)) {
			return {
				specifier: host.specifier,
				valueNames: [],
				typeNames: [],
				value: !node.isTypeOnly,
				moduleSpecifier: host.node,
			};
		}
		if (!isNamedExports(clause)) return undefined;
		const valueNames: string[] = [];
		const typeNames: string[] = [];
		for (const element of clause.elements) {
			const name = (element.propertyName ?? element.name).text;
			if (node.isTypeOnly || element.isTypeOnly) typeNames.push(name);
			else valueNames.push(name);
		}
		return {
			specifier: host.specifier,
			valueNames,
			typeNames,
			value: valueNames.length > 0,
			moduleSpecifier: host.node,
		};
	}
	if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
		const host = hostSpecifier(node.arguments[0]);
		if (host === undefined) return undefined;
		return { specifier: host.specifier, valueNames: [], typeNames: [], value: true, moduleSpecifier: host.node };
	}
	return undefined;
}

function hostSpecifier(node: Node | undefined): { readonly specifier: string; readonly node: Node } | undefined {
	if (node === undefined || !isStringLiteral(node)) return undefined;
	return node.text.startsWith(HOST_SCOPE) ? { specifier: node.text, node } : undefined;
}

function declared(manifest: Manifest | undefined, name: string): boolean {
	if (manifest === undefined) return false;
	return DEPENDENCY_SECTIONS.some((section) => manifest.sections.get(section)?.has(name) === true);
}

function declarationOf(file: string): string {
	const extension = path.extname(file);
	const suffix = DECLARATION_SUFFIXES[extension];
	if (suffix === undefined) return file;
	const declaration = `${file.slice(0, -extension.length)}${suffix}`;
	return existsSync(declaration) ? declaration : file;
}
function resolveTarget(specifier: string, from: string, root: string): Resolution {
	if (path.isAbsolute(specifier)) return { ok: true, path: specifier };
	return resolveSpecifier(specifier, from, root);
}

function resolveSpecifier(specifier: string, from: string, root: string): Resolution {
	let resolved: string;
	try {
		resolved = Bun.resolveSync(specifier, from);
	} catch (error) {
		return { ok: false, reason: messageOf(error) };
	}
	const modules = path.join(root, "node_modules");
	const installed = existsSync(modules) ? realpathSync(modules) : modules;
	const real = existsSync(resolved) ? realpathSync(resolved) : resolved;
	if (real.startsWith(`${installed}${path.sep}`)) return { ok: true, path: resolved };
	return { ok: false, reason: `it resolves to ${resolved}, outside ${modules}` };
}

function importSite(site: Site): ImportSite {
	return { file: site.file, line: site.line, specifier: site.specifier };
}

function siteKey(site: Site): string {
	return `${site.file}#${site.index}`;
}

function relativePosix(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join("/");
}

function compareText(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function compareFailures(left: UpstreamFailure, right: UpstreamFailure): number {
	const leftSite = left.kind === "module-table-unavailable" ? undefined : left.site;
	const rightSite = right.kind === "module-table-unavailable" ? undefined : right.site;
	const byFile = compareText(leftSite?.file ?? "", rightSite?.file ?? "");
	if (byFile !== 0) return byFile;
	const byLine = (leftSite?.line ?? 0) - (rightSite?.line ?? 0);
	if (byLine !== 0) return byLine;
	const bySpecifier = compareText(leftSite?.specifier ?? "", rightSite?.specifier ?? "");
	if (bySpecifier !== 0) return bySpecifier;
	const bySymbol = compareText("symbol" in left ? left.symbol : "", "symbol" in right ? right.symbol : "");
	if (bySymbol !== 0) return bySymbol;
	return compareText(left.kind, right.kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
