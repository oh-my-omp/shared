import { existsSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import type { GatedShape, Shape, SourceSet } from "./model.ts";

const EXCLUDED_DIRS: Record<string, true> = { node_modules: true, dist: true };
const NON_PRODUCTION_DIRS: Record<string, true> = {
	test: true,
	tests: true,
	eval: true,
	bench: true,
	demo: true,
	research: true,
	sandbox: true,
};
const CONFIG_BUNDLE_SCOPES = ["agent/extensions/", "agent/extensions-last/"];
const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;
const NON_PRODUCTION_SOURCE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/;
const TEST_FILE = /^.+[._](?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const PACKAGE_JSON = z.object({ name: z.unknown().optional(), omp: z.unknown().optional() });
const OMP_SECTION = z.object({ extensions: z.unknown().optional() });
const EXTENSIONS = z.array(z.unknown());

type PackageJson = z.infer<typeof PACKAGE_JSON>;

function extensionShape(omp: unknown): Shape | undefined {
	const section = OMP_SECTION.safeParse(omp);
	if (!section.success) return undefined;
	const value = section.data.extensions;
	if (value === undefined) return undefined;
	const parsed = EXTENSIONS.safeParse(value);
	if (!parsed.success) return { kind: "exempt", reason: "package.json: omp.extensions is not an array" };
	let entries: [string, ...string[]] | undefined;
	for (const [index, entry] of parsed.data.entries()) {
		if (typeof entry !== "string" || entry.length === 0) {
			return { kind: "exempt", reason: `package.json: omp.extensions[${index}] is not a non-empty string` };
		}
		const normalized = path.posix.normalize(entry.replace(/^(?:\.\/)+/, ""));
		if (entries === undefined) entries = [normalized];
		else entries.push(normalized);
	}
	if (entries === undefined) return { kind: "exempt", reason: "package.json: omp.extensions is empty" };
	const [first] = entries;
	return entries.length === 1 ? { kind: "plugin-single", entries: [first] } : { kind: "plugin-multi", entries };
}

function shapeFromManifest(root: string, manifest: PackageJson): Shape {
	if (
		manifest.name === "omomp-shared" &&
		statSync(path.join(root, "src"), { throwIfNoEntry: false })?.isDirectory() === true
	) {
		return { kind: "shared-source" };
	}
	const extensionsDir = path.join(root, "agent", "extensions");
	if (
		statSync(extensionsDir, { throwIfNoEntry: false })?.isDirectory() === true &&
		statSync(path.join(extensionsDir, "_shared", "package.json"), { throwIfNoEntry: false })?.isFile() === true
	) {
		return { kind: "config-bundle" };
	}
	const declared = extensionShape(manifest.omp);
	if (declared !== undefined) return declared;
	return {
		kind: "exempt",
		reason: "package.json declares no omp.extensions entries, is not named omomp-shared, and is not an omp-config bundle",
	};
}

export async function deriveShape(root: string): Promise<Shape> {
	const manifestPath = path.join(root, "package.json");
	if (!existsSync(manifestPath)) return { kind: "exempt", reason: "no package.json in the repository root" };
	let text: string;
	try {
		text = await readFile(manifestPath, "utf8");
	} catch (error) {
		return {
			kind: "exempt",
			reason: `package.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			kind: "exempt",
			reason: `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { kind: "exempt", reason: "package.json is not a JSON object" };
	}
	return shapeFromManifest(root, PACKAGE_JSON.parse(raw));
}

async function walk(dir: string, files: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const target = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRS[entry.name] === true || entry.name.startsWith(".")) continue;
			await walk(target, files);
			continue;
		}
		if (entry.isFile()) {
			files.push(target);
			continue;
		}
		if (!entry.isSymbolicLink()) continue;
		const stats = await stat(target).catch(() => undefined);
		if (stats?.isFile() === true) files.push(target);
	}
}

export async function collectSources(root: string, shape: GatedShape): Promise<SourceSet> {
	const absolute: string[] = [];
	await walk(root, absolute);
	const files = absolute.map((file) => path.relative(root, file).split(path.sep).join("/"));
	files.sort();
	const production: string[] = [];
	const nonProduction: string[] = [];
	const tests: string[] = [];
	for (const file of files) {
		const segments = file.split("/");
		const base = segments[segments.length - 1] ?? "";
		if (TEST_FILE.test(base)) tests.push(file);
		if (!TS_SOURCE.test(base)) continue;
		if (shape.kind === "config-bundle" && !CONFIG_BUNDLE_SCOPES.some((scope) => file.startsWith(scope))) continue;
		const nonProductionPath = segments.some(
			(segment, index) => index < segments.length - 1 && NON_PRODUCTION_DIRS[segment] === true,
		);
		if (NON_PRODUCTION_SOURCE.test(base) || nonProductionPath) {
			nonProduction.push(file);
			continue;
		}
		production.push(file);
	}
	return { production, nonProduction, tests };
}
