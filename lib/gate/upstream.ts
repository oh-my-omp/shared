import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
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
import type { HostPackage, ImportSite, SourceSet, UpstreamFailure } from "./model.ts";
import { lineOf, type ModuleExports, type TsHost, type TsProject } from "./ts-project.ts";

const HOST_SCOPE = "@oh-my-pi/";
const CODING_AGENT = "@oh-my-pi/pi-coding-agent";
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

type Table = {
	readonly entries: ReadonlyMap<string, string>;
	readonly bundled: ReadonlySet<string>;
};

type TableLoad =
	| { readonly ok: true; readonly table: Table; readonly piManifest: string }
	| { readonly ok: false; readonly reason: string };

type Resolution = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

export async function installedHostPackages(root: string): Promise<HostPackage[]> {
	const scope = path.join(root, "node_modules", HOST_SCOPE.slice(0, -1));
	let entries: Dirent[];
	try {
		entries = readdirSync(scope, { withFileTypes: true });
	} catch {
		return [];
	}
	const packages: HostPackage[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(path.join(scope, entry.name, "package.json"), "utf8"));
		} catch {
			continue;
		}
		if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") continue;
		packages.push({ name: value.name, version: value.version });
	}
	packages.sort((left, right) => compareText(left.name, right.name));
	return packages;
}

export async function checkUpstreamExports(input: {
	readonly root: string;
	readonly manifest: Manifest | undefined;
	readonly sources: SourceSet;
	readonly host: TsHost;
}): Promise<{ readonly failures: UpstreamFailure[]; readonly nonProduction: UpstreamFailure[] }> {
	const { root, manifest, sources, host } = input;
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
	await checkSymbols({ root, sources, host, productionSites, targets, failures });
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
		if (table.bundled.has(packageName)) {
			const importSpecifier = table.entries.get(site.specifier);
			if (importSpecifier === undefined) {
				bucket.push({ kind: "unbundled-subpath", site: importSite(site), package: packageName });
				continue;
			}
			const resolved = resolveTarget(importSpecifier, piManifest);
			if (!resolved.ok) {
				bucket.push({ kind: "unresolved-target", site: importSite(site), reason: resolved.reason });
				continue;
			}
			if (!existsSync(resolved.path)) {
				bucket.push({ kind: "unresolved-target", site: importSite(site), reason: `${resolved.path} does not exist on disk` });
				continue;
			}
			targets?.set(siteKey(site), resolved.path);
			continue;
		}
		if (!declared(manifest, packageName)) {
			bucket.push({ kind: "undeclared-package", site: importSite(site), package: packageName });
			continue;
		}
		const resolved = resolveSpecifier(site.specifier, rootManifest);
		if (!resolved.ok) {
			bucket.push({ kind: "unresolved-target", site: importSite(site), reason: resolved.reason });
			continue;
		}
		if (!existsSync(resolved.path)) {
			bucket.push({ kind: "unresolved-target", site: importSite(site), reason: `${resolved.path} does not exist on disk` });
			continue;
		}
		targets?.set(siteKey(site), resolved.path);
	}
}

async function checkSymbols(input: {
	readonly root: string;
	readonly sources: SourceSet;
	readonly host: TsHost;
	readonly productionSites: readonly Site[];
	readonly targets: ReadonlyMap<string, string>;
	readonly failures: UpstreamFailure[];
}): Promise<void> {
	const checked = input.productionSites.filter(
		(site) => site.typeNames.length > 0 || (site.valueNames.length > 0 && input.targets.has(siteKey(site))),
	);
	if (checked.length === 0) return;
	const project = await input.host.open([
		...new Set([...input.sources.production, ...input.sources.nonProduction, ...input.targets.values()]),
	]);
	const moduleSpecifiers = new Map<string, Node>();
	for (const site of await collectSites(input.root, project, input.sources.production)) {
		moduleSpecifiers.set(siteKey(site), site.moduleSpecifier);
	}
	const exportTables = new Map<string, ModuleExports | undefined>();
	const typeTables = new Map<string, ModuleExports | undefined>();
	for (const site of checked) {
		const target = input.targets.get(siteKey(site));
		if (site.valueNames.length > 0 && target !== undefined) {
			if (!exportTables.has(target)) exportTables.set(target, await project.exportsOfFile(target));
			const exports = exportTables.get(target);
			if (exports === undefined) {
				input.failures.push({
					kind: "unresolved-target",
					site: importSite(site),
					reason: `TypeScript resolved no module for ${target}`,
				});
			} else {
				const targetText = relativePosix(input.root, target);
				for (const symbol of site.valueNames) {
					const kind = exports.get(symbol);
					if (kind === undefined) input.failures.push({ kind: "missing-export", site: importSite(site), symbol, target: targetText });
					else if (kind === "type") input.failures.push({ kind: "type-only-export", site: importSite(site), symbol, target: targetText });
				}
			}
		}
		if (site.typeNames.length > 0) {
			const key = `${site.file}#${site.specifier}`;
			if (!typeTables.has(key)) {
				const node = moduleSpecifiers.get(siteKey(site));
				typeTables.set(key, node === undefined ? undefined : await project.exportsAt(node));
			}
			const exports = typeTables.get(key);
			if (exports === undefined) {
				input.failures.push({
					kind: "unresolved-target",
					site: importSite(site),
					reason: `TypeScript resolved no module for '${site.specifier}'`,
				});
			} else {
				for (const symbol of site.typeNames) {
					if (!exports.has(symbol)) {
						input.failures.push({ kind: "missing-type-export", site: importSite(site), symbol, target: site.specifier });
					}
				}
			}
		}
	}
}

async function loadModuleTable(root: string): Promise<TableLoad> {
	let piManifest: string;
	try {
		piManifest = Bun.resolveSync(`${CODING_AGENT}/package.json`, path.join(root, "package.json"));
	} catch (error) {
		return { ok: false, reason: `cannot resolve ${CODING_AGENT}/package.json from ${root}: ${messageOf(error)}` };
	}
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
	const bundled = new Set<string>();
	for (const key of entries.keys()) if (isBundledRoot(key)) bundled.add(key);
	return { ok: true, table: { entries, bundled }, piManifest };
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

function isBundledRoot(key: string): boolean {
	if (!key.startsWith(HOST_SCOPE)) return false;
	const name = key.slice(HOST_SCOPE.length);
	return name.length > 0 && !name.includes("/");
}

function declared(manifest: Manifest | undefined, name: string): boolean {
	if (manifest === undefined) return false;
	return DEPENDENCY_SECTIONS.some((section) => manifest.sections.get(section)?.has(name) === true);
}

function resolveTarget(specifier: string, from: string): Resolution {
	if (path.isAbsolute(specifier)) return { ok: true, path: specifier };
	return resolveSpecifier(specifier, from);
}

function resolveSpecifier(specifier: string, from: string): Resolution {
	try {
		return { ok: true, path: Bun.resolveSync(specifier, from) };
	} catch (error) {
		return { ok: false, reason: messageOf(error) };
	}
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
