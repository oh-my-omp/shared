// `bun sync.ts`: the push sync. For every unarchived repository of the oh-my-omp organization whose base branch
// holds an `omomp-shared.json`, compares the declared copies with `src/` of this shared checkout (the same
// `lib/consumer.ts` judgment `verify.ts` uses) and keeps exactly one sync pull request per repository and base:
// copies behind → one commit rebuilt on the base (the copies, plus one `## [Unreleased]` → `### Changed` item when
// the repository has a root `CHANGELOG.md`) force-pushed to `omomp-shared-sync/<base>`, and a PR opened or updated;
// copies equal → an open sync PR is closed. It never merges. One log line per repository says what happened.
//
// Environment: GH_TOKEN (the sync App's installation token), BASE (optional branch name: use it as the base in every
// repository and skip repositories without it; empty means each repository's default branch), SHARED_COMMIT
// (the shared commit being synced; defaults to this checkout's HEAD). Exit 1 when any repository failed.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addChangedItem } from "./lib/changelog.ts";
import { compareCopies, copyPlans, DECLARATION_FILE, type Declaration, readDeclaration } from "./lib/consumer.ts";
import { GitHub, GitHubError, type Repository } from "./lib/github.ts";

const OWNER = "oh-my-omp";
const SHARED_REPO = "shared";
const SHARED_ROOT = import.meta.dir;
const SRC_DIR = path.join(SHARED_ROOT, "src");
const SYNC_PREFIX = "omomp-shared-sync/";

type Outcome =
	| { readonly kind: "opened"; readonly pr: string; readonly files: readonly string[] }
	| { readonly kind: "updated"; readonly pr: string; readonly files: readonly string[] }
	| { readonly kind: "closed"; readonly pr: string }
	| { readonly kind: "in_sync" }
	| { readonly kind: "skipped"; readonly reason: string }
	| { readonly kind: "failed"; readonly reason: string };

function describe(o: Outcome): string {
	switch (o.kind) {
		case "opened":
			return `opened ${o.pr} (${o.files.join(", ")})`;
		case "updated":
			return `updated ${o.pr} (${o.files.join(", ")})`;
		case "closed":
			return `closed ${o.pr}: copies match`;
		case "in_sync":
			return "in sync: copies match, no sync PR open";
		case "skipped":
			return `skipped: ${o.reason}`;
		case "failed":
			return `failed: ${o.reason}`;
		default: {
			const never: never = o;
			return never;
		}
	}
}

function sharedCommit(): string {
	const fromEnv = process.env.SHARED_COMMIT?.trim();
	if (fromEnv) return fromEnv;
	const r = Bun.spawnSync(["git", "-C", SHARED_ROOT, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
	if (r.exitCode !== 0) throw new Error("SHARED_COMMIT is unset and this checkout has no git HEAD");
	return r.stdout.toString().trim();
}

/** A scratch consumer root holding the declaration and the declared copies as they are at `ref`. */
async function materialize(gh: GitHub, repo: string, ref: string, declarationText: Uint8Array, scratch: string) {
	const root = path.join(scratch, repo);
	await mkdir(root, { recursive: true });
	await writeFile(path.join(root, DECLARATION_FILE), declarationText);
	const read = await readDeclaration(root, SRC_DIR);
	if (read.kind !== "declared") return { root, read };
	for (const file of read.declaration.files) {
		const rel = path.posix.join(read.declaration.directory, file);
		const bytes = await gh.file(repo, rel, ref);
		if (bytes === null) continue;
		await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
		await writeFile(path.join(root, rel), bytes);
	}
	return { root, read };
}

function prBody(commit: string, declaration: Declaration, stale: readonly string[]): string {
	const short = commit.slice(0, 7);
	return [
		`Updates the copies of [oh-my-omp/shared@${short}](https://github.com/${OWNER}/${SHARED_REPO}/commit/${commit}) that this repository declares in \`${DECLARATION_FILE}\`.`,
		"",
		"Updated files:",
		...stale.map((f) => `- \`${path.posix.join(declaration.directory, f)}\` ← \`src/${f}\``),
		"",
		`Opened by the push sync of oh-my-omp/shared; it is rebuilt on the base branch on every sync and never merged by the sync.`,
	].join("\n");
}

async function syncRepository(gh: GitHub, repo: Repository, baseOverride: string, commit: string, scratch: string): Promise<Outcome> {
	if (repo.archived) return { kind: "skipped", reason: "archived" };
	if (repo.name === SHARED_REPO) return { kind: "skipped", reason: "the shared repository itself" };
	const base = baseOverride || repo.defaultBranch;
	const head = await gh.branchHead(repo.name, base);
	if (head === null) return { kind: "skipped", reason: `no branch ${base}` };
	const declarationText = await gh.file(repo.name, DECLARATION_FILE, head.commit);
	if (declarationText === null) return { kind: "skipped", reason: `no ${DECLARATION_FILE} on ${base}` };
	const { root, read } = await materialize(gh, repo.name, head.commit, declarationText, scratch);
	if (read.kind !== "declared") {
		return {
			kind: "failed",
			reason: read.kind === "invalid" ? `invalid ${DECLARATION_FILE}: ${read.problems.join("; ")}` : "declaration vanished",
		};
	}
	const states = await compareCopies(copyPlans(root, SRC_DIR, read.declaration));
	const stale = states.filter((s) => s.kind !== "match").map((s) => s.plan.file);
	const branch = `${SYNC_PREFIX}${base}`;
	const open = await gh.openPull(repo.name, branch, base);
	if (stale.length === 0) {
		if (open === null) return { kind: "in_sync" };
		await gh.updatePull(repo.name, open.number, { state: "closed" });
		return { kind: "closed", pr: open.url };
	}
	const entries = await Promise.all(
		stale.map(async (file) => ({
			path: path.posix.join(read.declaration.directory, file),
			content: await Bun.file(path.join(SRC_DIR, file)).text(),
		})),
	);
	const changelog = await gh.file(repo.name, "CHANGELOG.md", head.commit);
	const short = commit.slice(0, 7);
	if (changelog !== null) {
		const item = `Updated the shared ${stale.length === 1 ? "copy" : "copies"} of ${stale.map((f) => `\`${f}\``).join(", ")} to oh-my-omp/shared@${short}.`;
		entries.push({ path: "CHANGELOG.md", content: addChangedItem(new TextDecoder().decode(changelog), item) });
	}
	const sha = await gh.commit(repo.name, {
		parent: head.commit,
		baseTree: head.tree,
		entries,
		message: `chore: synced shared copies from oh-my-omp/shared@${short}`,
	});
	await gh.forceBranch(repo.name, branch, sha);
	const title = `同步 oh-my-omp/shared@${short} 的公共文件副本`;
	const body = prBody(commit, read.declaration, stale);
	if (open !== null) {
		await gh.updatePull(repo.name, open.number, { title, body });
		return { kind: "updated", pr: open.url, files: stale };
	}
	const pr = await gh.createPull(repo.name, { head: branch, base, title, body });
	return { kind: "opened", pr: pr.url, files: stale };
}

const token = process.env.GH_TOKEN;
if (!token) {
	console.error("sync.ts: GH_TOKEN is not set");
	process.exit(2);
}
const gh = new GitHub(token, OWNER);
const baseOverride = process.env.BASE?.trim() ?? "";
const commit = sharedCommit();
const scratch = await mkdtemp(path.join(tmpdir(), "omomp-sync-"));
console.log(`omomp-sync: shared ${commit.slice(0, 12)}, base ${baseOverride || "(each repository's default branch)"}`);
let failures = 0;
try {
	const repos = (await gh.repositories()).sort((a, b) => a.name.localeCompare(b.name));
	for (const repo of repos) {
		let outcome: Outcome;
		try {
			outcome = await syncRepository(gh, repo, baseOverride, commit, scratch);
		} catch (error) {
			outcome = { kind: "failed", reason: error instanceof GitHubError || error instanceof Error ? error.message : String(error) };
		}
		if (outcome.kind === "failed") failures++;
		console.log(`omomp-sync: ${OWNER}/${repo.name}: ${describe(outcome)}`);
	}
} finally {
	await rm(scratch, { recursive: true, force: true });
}
process.exit(failures > 0 ? 1 : 0);
