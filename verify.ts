// `bun verify.ts <consumer repository root>`: compares the copies a repository declares in `omomp-shared.json` with
// the files under `src/` of the shared checkout this script runs from. Exit 0: every copy matches, or the repository
// declares nothing. Exit 1: a copy is missing or differs, or the declaration is invalid. Exit 2: usage error.

import path from "node:path";
import { compareCopies, copyPlans, DECLARATION_FILE, readDeclaration } from "./lib/consumer.ts";

const SHARED_ROOT = import.meta.dir;
const SRC_DIR = path.join(SHARED_ROOT, "src");

function sharedCommit(): string {
	const r = Bun.spawnSync(["git", "-C", SHARED_ROOT, "rev-parse", "--short=12", "HEAD"], { stdout: "pipe", stderr: "ignore" });
	return r.exitCode === 0 ? r.stdout.toString().trim() : "(not a git checkout)";
}

const arg = Bun.argv[2];
if (arg === undefined || Bun.argv.length > 3) {
	console.error("usage: bun verify.ts <consumer repository root>");
	process.exit(2);
}
/** Prints the verdict for `root` and returns the exit code. */
async function verify(root: string): Promise<0 | 1> {
	const commit = sharedCommit();
	const read = await readDeclaration(root, SRC_DIR);
	switch (read.kind) {
		case "absent":
			console.log(`${root}: no ${DECLARATION_FILE}; this repository consumes no shared files`);
			return 0;
		case "invalid":
			console.log(`${root}: ${DECLARATION_FILE} is invalid (shared ${commit}):`);
			for (const p of read.problems) console.log(`  invalid: ${p}`);
			return 1;
		case "declared": {
			const states = await compareCopies(copyPlans(root, SRC_DIR, read.declaration));
			const bad = states.filter((s) => s.kind !== "match");
			const copies = (n: number) => `${n} ${n === 1 ? "copy" : "copies"}`;
			if (bad.length === 0) {
				console.log(`${root}: ${copies(states.length)} ${states.length === 1 ? "matches" : "match"} shared ${commit}`);
				return 0;
			}
			console.log(`${root}: ${bad.length} of ${copies(states.length)} ${bad.length === 1 ? "does" : "do"} not match shared ${commit}:`);
			for (const s of bad) console.log(`  ${s.kind}: ${path.relative(root, s.plan.copy)} (shared src/${s.plan.file})`);
			return 1;
		}
	}
}

process.exit(await verify(path.resolve(arg)));
