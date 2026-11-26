import { type Dirent, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import { DEPENDENCY_SECTIONS, parseManifest } from "./deps.ts";
import type { HostPackage } from "./gate/model.ts";

const HOST_SCOPE = "@oh-my-pi/";
const INSTALLED_MANIFEST = z.object({ name: z.string(), version: z.string() });
const BUN_LOCK = z.object({ packages: z.record(z.string(), z.array(z.unknown())) });

function byName(packages: HostPackage[]): HostPackage[] {
	return packages.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function isHostName(name: string): boolean {
	return name.startsWith(HOST_SCOPE) && name.length > HOST_SCOPE.length && !name.includes("/", HOST_SCOPE.length);
}

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

export function installedHostPackages(root: string): HostPackage[] {
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
		const text = readText(path.join(scope, entry.name, "package.json"));
		if (text === undefined) continue;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			continue;
		}
		const manifest = INSTALLED_MANIFEST.safeParse(value);
		if (!manifest.success || manifest.data.name !== `${HOST_SCOPE}${entry.name}`) continue;
		packages.push({ name: manifest.data.name, version: manifest.data.version });
	}
	return byName(packages);
}

export function lockedHostPackages(root: string): HostPackage[] | undefined {
	const text = readText(path.join(root, "bun.lock"));
	if (text === undefined) return undefined;
	let lock: unknown;
	try {
		lock = Bun.JSONC.parse(text);
	} catch {
		return undefined;
	}
	const parsed = BUN_LOCK.safeParse(lock);
	if (!parsed.success) return undefined;
	const packages: HostPackage[] = [];
	for (const [key, entry] of Object.entries(parsed.data.packages)) {
		if (!isHostName(key) || typeof entry[0] !== "string") continue;
		const resolved = entry[0];
		const at = resolved.lastIndexOf("@");
		if (at <= 0 || resolved.slice(0, at) !== key) continue;
		packages.push({ name: key, version: resolved.slice(at + 1) });
	}
	return byName(packages);
}

export function declaredHostPackages(root: string): HostPackage[] | undefined {
	const text = readText(path.join(root, "package.json"));
	if (text === undefined) return undefined;
	const parsed = parseManifest(text);
	if (!parsed.ok) return undefined;
	const declared = new Map<string, string>();
	for (const section of DEPENDENCY_SECTIONS) {
		for (const [name, spec] of parsed.manifest.sections.get(section) ?? []) {
			if (isHostName(name) && !declared.has(name)) declared.set(name, spec);
		}
	}
	return byName([...declared].map(([name, version]) => ({ name, version })));
}
