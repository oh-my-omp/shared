/**
 * Adapter around Tern's own `tern plugin` CLI: Tern owns registration and
 * installation, this file only asks it questions and relays its answers.
 *
 * - `findTern` locates the `tern` executable on `PATH` — on Windows only the
 *   `PATHEXT` extensions that start a program by argv (`.exe`, `.com`; `.exe`
 *   even when PATHEXT omits it), never a `.bat`/`.cmd` shim that would need
 *   cmd — and reports `not_installed` instead of throwing when it is absent.
 * - `TernPluginCli` runs `tern plugin <verb>` as an argument vector through the
 *   host's `ptree` spawn helper (`@oh-my-pi/pi-utils`), which is the host's
 *   argv spawn with a kill-the-tree deadline and captured output; nothing ever
 *   goes through a shell. Every call carries a timeout.
 * - `dir` and `list` answers are parsed strictly: the plugins directory must be
 *   an absolute path, and each list entry must carry id, version, css and a
 *   ready/disabled/failed status. Malformed output is a `dir`/`list` error.
 * - `readPluginManifest` parses a package's `plugin.toml` (Bun's TOML parser)
 *   and asserts the declared id; `pluginCopyMatches` compares an installed
 *   copy against the package directory byte for byte.
 *
 * Every failure is a returned `TernPluginError` whose `stage` names the step
 * that failed. Choosing install over link, throwing versus notifying, and
 * when to reload are the caller's decisions, not this file's.
 */
import { type Stats, statSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { z, type zod } from "@oh-my-pi/pi-coding-agent";
import { ptree } from "@oh-my-pi/pi-utils";

/** The `tern plugin` step a failure belongs to. */
export type TernPluginStage = "find" | "dir" | "list" | "install" | "link" | "reload" | "remove" | "unlink" | "verify";

/** A failure returned by this file; nothing here throws for expected problems. */
export interface TernPluginError {
	readonly stage: TernPluginStage;
	readonly message: string;
}

export type TernResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: TernPluginError };

function fail<T>(stage: TernPluginStage, message: string): TernResult<T> {
	return { ok: false, error: { stage, message } };
}

// Each mutation reloads Tern's daemon, whose documented wait is up to 60 seconds.
const DEFAULT_TIMEOUT_MS = 75_000;

/** Inputs `findTern` and the resulting client honour; every field defaults to the live process. */
export interface TernFindOptions {
	/** Environment consulted for PATH (and PATHEXT on Windows) and given to spawned `tern` calls. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** Override the platform detection; `win32` turns on `;` separators and PATHEXT probing. */
	readonly platform?: NodeJS.Platform;
	/** Deadline applied to every spawned `tern plugin` call, in milliseconds. */
	readonly timeoutMs?: number;
}

/** How Tern reports one plugin's load state in `tern plugin list --json`. */
export type TernPluginStatus = { readonly kind: "ready" | "disabled" } | { readonly kind: "failed"; readonly detail: string };

/** One entry of a parsed `tern plugin list --json` answer. */
export interface TernPluginEntry {
	readonly id: string;
	readonly version: string;
	readonly css: string;
	readonly status: TernPluginStatus;
}

/** `tern` resolved on PATH: every method spawns `tern plugin <verb>` with argv and a timeout. */
export interface TernPluginCli {
	/** Absolute path of the resolved executable. */
	readonly path: string;
	/** `plugin dir --json` → the absolute plugins directory. */
	dir(): Promise<TernResult<string>>;
	/** `plugin list --json` → every listed plugin with id, version, css and status. */
	list(): Promise<TernResult<TernPluginEntry[]>>;
	/** `plugin install --force <dir> --json` → the installed {id, version, dir} Tern reports. */
	install(dir: string): Promise<TernResult<{ id: string; version: string; dir: string }>>;
	/** `plugin link <dir> --json`. */
	link(dir: string): Promise<TernResult<void>>;
	/** `plugin reload <id> --json`. */
	reload(id: string): Promise<TernResult<void>>;
	/** `plugin remove <id> --json`. */
	remove(id: string): Promise<TernResult<void>>;
	/** `plugin unlink <id> --json`. */
	unlink(id: string): Promise<TernResult<void>>;
}

/** Result of `findTern`: the executable plus a ready client, or its absence. */
export type TernFindResult =
	| { readonly kind: "found"; readonly path: string; readonly cli: TernPluginCli }
	| { readonly kind: "not_installed" };

const absolutePath = z.string().refine(isAbsolute, "must be an absolute path");
const dirSchema = z.object({ dir: absolutePath });
const listSchema = z.object({
	plugins: z.array(
		z.object({
			id: z.string(),
			version: z.string(),
			css: z.string(),
			status: z.union([z.enum(["ready", "disabled"]), z.object({ failed: z.string() })]),
		}),
	),
});
const installedSchema = z.object({ id: z.string(), version: z.string(), dir: absolutePath });

/** Windows extensions that start a program by argv without cmd; PATHEXT may list others (`.BAT`, `.CMD`, scripts). */
const WINDOWS_ARGV_EXTS = [".com", ".exe"];

/** Extensions probed for `tern`: PATHEXT's argv-startable ones on Windows (in PATHEXT order, `.EXE` always), the bare name elsewhere. */
function executableExtensions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	if (platform !== "win32") return [""];
	const exts = (env.PATHEXT ?? "")
		.split(";")
		.map((ext) => ext.trim().toLowerCase())
		.filter((ext) => WINDOWS_ARGV_EXTS.includes(ext));
	// `tern` is a native binary; `.exe` must be tried even when PATHEXT omits it. Windows file names are
	// case-insensitive, so the lowercase probe finds `tern.EXE` too.
	if (!exts.includes(".exe")) exts.push(".exe");
	return exts;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Absolute path of `tern` on the given PATH, or undefined. Windows tries every PATHEXT extension. */
function findOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
	const pathVar = env.PATH ?? env.Path ?? "";
	const pathDelimiter = platform === "win32" ? ";" : delimiter;
	for (const dir of pathVar.split(pathDelimiter)) {
		if (!dir) continue;
		for (const ext of executableExtensions(platform, env)) {
			// resolve() (not join): a relative PATH entry must not yield a cwd-dependent result.
			const full = resolve(dir, `tern${ext}`);
			if (isFile(full)) return full;
		}
	}
	return undefined;
}

type CliOutcome = { readonly kind: "ok"; readonly stdout: string } | { readonly kind: "failed"; readonly message: string };

/**
 * Spawn `[tern, "plugin", ...args]` with argv — never a shell — through the host's
 * `ptree` spawn helper: `timeout` arms its kill-the-tree deadline and `wait`
 * captures stdout and a bounded stderr tail. Non-zero exits, timeouts and
 * spawn failures all come back as `failed` instead of throwing.
 */
async function runTernPlugin(tern: string, args: readonly string[], options: TernFindOptions): Promise<CliOutcome> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	try {
		using child = ptree.spawn([tern, "plugin", ...args], { timeout: timeoutMs, stderr: "full", env: options.env });
		const result = await child.wait({ allowAbort: true, allowNonZero: true, stderr: "full" });
		if (result.exitError instanceof ptree.TimeoutError) {
			return { kind: "failed", message: `timed out after ${timeoutMs}ms` };
		}
		if (result.exitCode !== 0) {
			const stderr = result.stderr.trim();
			return { kind: "failed", message: `exited ${result.exitCode}${stderr ? `: ${stderr}` : ""}` };
		}
		if (result.exitError !== undefined) {
			return { kind: "failed", message: `aborted: ${result.exitError.message}` };
		}
		return { kind: "ok", stdout: result.stdout };
	} catch (error) {
		return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
	}
}

/** Run a verb that answers JSON, then apply `schema`; parse problems report the verb's stage. */
async function jsonVerb<T>(
	tern: string,
	stage: TernPluginStage,
	args: readonly string[],
	options: TernFindOptions,
	schema: zod.ZodLikeSchema<T>,
): Promise<TernResult<T>> {
	const outcome = await runTernPlugin(tern, args, options);
	if (outcome.kind === "failed") return fail(stage, `tern plugin ${args.join(" ")} ${outcome.message}`);
	let json: unknown;
	try {
		json = JSON.parse(outcome.stdout);
	} catch {
		return fail(stage, `tern plugin ${args.join(" ")} did not answer JSON: ${outcome.stdout.trim()}`);
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		return fail(
			stage,
			`tern plugin ${args.join(" ")} answered unexpected JSON: ${parsed.error.issues
				.map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	return { ok: true, value: parsed.data };
}

/** Run a mutation verb; its JSON answer is acknowledged but only Tern's exit code matters. */
async function mutation(
	tern: string,
	stage: TernPluginStage,
	args: readonly string[],
	options: TernFindOptions,
): Promise<TernResult<void>> {
	const outcome = await runTernPlugin(tern, args, options);
	if (outcome.kind === "failed") return fail(stage, `tern plugin ${args.join(" ")} ${outcome.message}`);
	return { ok: true, value: undefined };
}

function makeCli(tern: string, options: TernFindOptions): TernPluginCli {
	return {
		path: tern,
		dir: async () => {
			const parsed = await jsonVerb(tern, "dir", ["dir", "--json"], options, dirSchema);
			return parsed.ok ? { ok: true, value: parsed.value.dir } : parsed;
		},
		list: async () => {
			const parsed = await jsonVerb(tern, "list", ["list", "--json"], options, listSchema);
			if (!parsed.ok) return parsed;
			return {
				ok: true,
				value: parsed.value.plugins.map(
					(plugin): TernPluginEntry => ({
						id: plugin.id,
						version: plugin.version,
						css: plugin.css,
						status: typeof plugin.status === "string" ? { kind: plugin.status } : { kind: "failed", detail: plugin.status.failed },
					}),
				),
			};
		},
		install: (dir) => jsonVerb(tern, "install", ["install", dir, "--force", "--json"], options, installedSchema),
		link: (dir) => mutation(tern, "link", ["link", dir, "--json"], options),
		reload: (id) => mutation(tern, "reload", ["reload", id, "--json"], options),
		remove: (id) => mutation(tern, "remove", ["remove", id, "--json"], options),
		unlink: (id) => mutation(tern, "unlink", ["unlink", id, "--json"], options),
	};
}

/**
 * Find `tern` on PATH. POSIX checks the bare name; Windows checks `tern.com`
 * and `tern.exe` in PATHEXT order (`.exe` always) in each PATH directory and
 * ignores `.bat`/`.cmd` shims, which only cmd can start.
 */
export function findTern(options: TernFindOptions = {}): TernFindResult {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const path = findOnPath(env, platform);
	if (path === undefined) return { kind: "not_installed" };
	return { kind: "found", path, cli: makeCli(path, options) };
}

/** The identity a plugin package declares in `plugin.toml`. */
export interface TernPluginManifest {
	readonly id: string;
	readonly version: string | undefined;
}

/**
 * Read `<dir>/plugin.toml` and assert it declares `expectedId`; the manifest's
 * `version` comes back for callers that compare it against Tern's listing.
 * A missing, unparseable or foreign manifest is a `verify` error.
 */
export async function readPluginManifest(dir: string, expectedId: string): Promise<TernResult<TernPluginManifest>> {
	const file = join(dir, "plugin.toml");
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		return fail("verify", `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let manifest: object;
	try {
		manifest = Bun.TOML.parse(text);
	} catch (error) {
		return fail("verify", `${file} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
	}
	const id = "id" in manifest ? manifest.id : undefined;
	if (typeof id !== "string") return fail("verify", `${file} declares no string id`);
	if (id !== expectedId) return fail("verify", `${file} declares id "${id}", expected "${expectedId}"`);
	const version = "version" in manifest ? manifest.version : undefined;
	if (version !== undefined && typeof version !== "string") return fail("verify", `${file} declares a non-string version`);
	return { ok: true, value: { id, version } };
}

/** Relative paths of the regular files under `dir`; a symlink anywhere makes the tree incomparable. */
async function fileInventory(root: string): Promise<string[] | undefined> {
	let rootStat: Stats;
	try {
		rootStat = await lstat(root);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
	const files: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<boolean> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isSymbolicLink()) return false;
			if (entry.isDirectory()) {
				if (!(await walk(full, rel))) return false;
			} else if (entry.isFile()) {
				files.push(rel);
			}
		}
		return true;
	};
	return (await walk(root, "")) ? files.sort() : undefined;
}

/**
 * Whether `installedDir` is a byte-for-byte copy of `packageDir`: same set of
 * relative paths, all regular files, equal bytes. A missing directory, a
 * symlink, a link marker (`.path` file lives next to the copy, not inside it)
 * or any difference answers `false`; filesystem errors are `verify` errors.
 */
export async function pluginCopyMatches(packageDir: string, installedDir: string): Promise<TernResult<boolean>> {
	let packageFiles: string[] | undefined;
	let installedFiles: string[] | undefined;
	try {
		[packageFiles, installedFiles] = await Promise.all([fileInventory(packageDir), fileInventory(installedDir)]);
	} catch (error) {
		return fail("verify", `cannot inventory plugin directories: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (packageFiles === undefined || installedFiles === undefined) return { ok: true, value: false };
	if (packageFiles.length !== installedFiles.length) return { ok: true, value: false };
	for (const [index, rel] of packageFiles.entries()) {
		if (rel !== installedFiles[index]) return { ok: true, value: false };
		try {
			const [expected, actual] = await Promise.all([readFile(join(packageDir, rel)), readFile(join(installedDir, rel))]);
			if (!expected.equals(actual)) return { ok: true, value: false };
		} catch (error) {
			return fail("verify", `cannot compare ${rel}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { ok: true, value: true };
}
