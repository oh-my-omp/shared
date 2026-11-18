// The consumer side of the copy mechanism: a repository's `omomp-shared.json` declaration, parsed and checked against
// a shared `src/` tree, and the byte comparison of the copies it declares. `verify.ts` and the push sync both go
// through these functions, so they never reach different conclusions about a repository.

import { readdir } from "node:fs/promises";
import path from "node:path";

export const DECLARATION_FILE = "omomp-shared.json";

/** What a repository declares: one target directory (relative to the repository root) and file names relative to shared `src/`. */
export type Declaration = { readonly directory: string; readonly files: readonly string[] };

export type DeclarationRead =
	| { readonly kind: "absent" }
	| { readonly kind: "invalid"; readonly problems: readonly string[] }
	| { readonly kind: "declared"; readonly declaration: Declaration };

/** One declared file: where its source lives in shared and where its copy lives in the consumer. */
export type CopyPlan = { readonly file: string; readonly source: string; readonly copy: string };

export type CopyState =
	| { readonly kind: "match"; readonly plan: CopyPlan }
	| { readonly kind: "missing"; readonly plan: CopyPlan }
	| { readonly kind: "differs"; readonly plan: CopyPlan };

const KEYS = ["directory", "files"] as const;

/** Parses the declaration text: a JSON object with exactly `directory` (string) and `files` (non-empty array of distinct strings). */
export function parseDeclaration(text: string): { ok: true; declaration: Declaration } | { ok: false; problems: string[] } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, problems: [`${DECLARATION_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, problems: [`${DECLARATION_FILE} must be a JSON object with "directory" and "files"`] };
	}
	const record = value as Record<string, unknown>;
	const problems: string[] = [];
	for (const key of Object.keys(record)) {
		if (!(KEYS as readonly string[]).includes(key)) problems.push(`unknown field "${key}"; only "directory" and "files" are allowed`);
	}
	const directory = record.directory;
	if (directory === undefined) problems.push(`missing field "directory"`);
	else if (typeof directory !== "string" || directory.trim() === "") problems.push(`"directory" must be a non-empty string`);
	const files = record.files;
	if (files === undefined) problems.push(`missing field "files"`);
	else if (!Array.isArray(files) || files.length === 0) problems.push(`"files" must be a non-empty array of file names`);
	else {
		const seen = new Set<string>();
		for (const f of files) {
			if (typeof f !== "string" || f.trim() === "") problems.push(`"files" entries must be non-empty strings, got ${JSON.stringify(f)}`);
			else if (seen.has(f)) problems.push(`"files" lists "${f}" twice`);
			else seen.add(f);
		}
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, declaration: { directory: directory as string, files: files as string[] } };
}

/** Every file under `srcDir`, as forward-slash paths relative to it. */
export async function sourceFiles(srcDir: string): Promise<string[]> {
	const entries = await readdir(srcDir, { recursive: true, withFileTypes: true });
	return entries
		.filter((e) => e.isFile())
		.map((e) => path.relative(srcDir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
		.sort();
}

const IMPORT_RE =
	/(?:^|[^\w$.])(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[^\w$.])import\s+["']([^"']+)["']/g;

/** The relative specifiers (`./x.ts`, `../y.ts`) a TypeScript source imports or re-exports, type-only imports included. */
export function relativeImports(code: string): string[] {
	const out: string[] = [];
	for (const m of code.matchAll(IMPORT_RE)) {
		const spec = m[1] ?? m[2] ?? m[3];
		if (spec !== undefined && (spec.startsWith("./") || spec.startsWith("../"))) out.push(spec);
	}
	return out;
}

/** Where an import of `spec` from shared file `from` lands, relative to `src/`; null when it leaves `src/`. */
export function resolveWithinSrc(from: string, spec: string): string | null {
	const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
	return joined.startsWith("../") || joined === ".." || path.posix.isAbsolute(joined) ? null : joined;
}

/** Checks a parsed declaration against the consumer root and the shared `src/` tree. */
export async function checkDeclaration(root: string, srcDir: string, declaration: Declaration): Promise<string[]> {
	const problems: string[] = [];
	const target = path.resolve(root, declaration.directory);
	const rel = path.relative(path.resolve(root), target);
	if (path.isAbsolute(declaration.directory) || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		problems.push(`"directory" ${JSON.stringify(declaration.directory)} resolves outside the repository root`);
	}
	const available = new Set(await sourceFiles(srcDir));
	const declared = new Set(declaration.files);
	for (const file of declaration.files) {
		if (!available.has(file)) {
			problems.push(`"${file}" is not a file in shared src/`);
			continue;
		}
		if (!file.endsWith(".ts")) continue;
		const code = await Bun.file(path.join(srcDir, file)).text();
		for (const spec of relativeImports(code)) {
			const dep = resolveWithinSrc(file, spec);
			if (dep === null) problems.push(`"${file}" imports ${JSON.stringify(spec)}, which is outside shared src/`);
			else if (!declared.has(dep)) problems.push(`"${file}" imports "${dep}", which is not declared`);
		}
	}
	return problems;
}

/** Reads and checks `<root>/omomp-shared.json` against the shared `src/` tree. */
export async function readDeclaration(root: string, srcDir: string): Promise<DeclarationRead> {
	const file = Bun.file(path.join(root, DECLARATION_FILE));
	if (!(await file.exists())) return { kind: "absent" };
	const parsed = parseDeclaration(await file.text());
	if (!parsed.ok) return { kind: "invalid", problems: parsed.problems };
	const problems = await checkDeclaration(root, srcDir, parsed.declaration);
	return problems.length > 0 ? { kind: "invalid", problems } : { kind: "declared", declaration: parsed.declaration };
}

/** The copies a valid declaration asks for. */
export function copyPlans(root: string, srcDir: string, declaration: Declaration): CopyPlan[] {
	return declaration.files.map((file) => ({
		file,
		source: path.join(srcDir, file),
		copy: path.join(root, declaration.directory, file),
	}));
}

/** Compares each copy with its shared source byte for byte. */
export async function compareCopies(plans: readonly CopyPlan[]): Promise<CopyState[]> {
	return Promise.all(
		plans.map(async (plan): Promise<CopyState> => {
			const copy = Bun.file(plan.copy);
			if (!(await copy.exists())) return { kind: "missing", plan };
			const [want, have] = await Promise.all([Bun.file(plan.source).bytes(), copy.bytes()]);
			return Buffer.from(want).equals(Buffer.from(have)) ? { kind: "match", plan } : { kind: "differs", plan };
		}),
	);
}
