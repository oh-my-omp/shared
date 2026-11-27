import { statSync } from "node:fs";
import path from "node:path";
import { dependencyProblems, describeDependencyProblem, hostPackages, type Manifest, parseManifest, shimProblems } from "./lib/deps.ts";
import { renderSummary, runGate, summaryJson } from "./lib/gate/run.ts";

const USAGE = "usage: bun deps.ts check|host <repository root>\n       bun deps.ts gate <repository root> [--summary <file>]";

type Command = { readonly kind: "check" } | { readonly kind: "host" } | { readonly kind: "gate"; readonly summary: string | undefined };

function parseCommand(args: readonly string[]): { readonly command: Command; readonly root: string } | undefined {
	const [name, root, ...rest] = args;
	if (root === undefined) return undefined;
	if ((name === "check" || name === "host") && rest.length === 0) return { command: { kind: name }, root };
	if (name !== "gate") return undefined;
	if (rest.length === 0) return { command: { kind: "gate", summary: undefined }, root };
	if (rest.length === 2 && rest[0] === "--summary" && rest[1] !== undefined) return { command: { kind: "gate", summary: rest[1] }, root };
	return undefined;
}

const parsed = parseCommand(Bun.argv.slice(2));
if (parsed === undefined) {
	console.error(USAGE);
	process.exit(2);
}
const { command } = parsed;
const root = path.resolve(parsed.root);
if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
	console.error(`deps.ts: ${root} is not a directory`);
	process.exit(2);
}

async function readManifest(): Promise<Manifest | undefined> {
	const file = Bun.file(path.join(root, "package.json"));
	if (!(await file.exists())) return undefined;
	const parsed = parseManifest(await file.text());
	if (parsed.ok) return parsed.manifest;
	for (const problem of parsed.problems) console.log(`  ${describeDependencyProblem(problem)}`);
	process.exit(1);
}

function trackedSources(): string[] {
	const listed = Bun.spawnSync(["git", "-C", root, "ls-files", "-z", "--", "*.ts", "*.mts", "*.cts", "*.tsx"], { stdout: "pipe", stderr: "pipe" });
	if (listed.exitCode !== 0) {
		console.error(`deps.ts: git ls-files failed in ${root}: ${listed.stderr.toString().trim()}`);
		process.exit(2);
	}
	return listed.stdout
		.toString()
		.split("\0")
		.filter((file) => file !== "");
}

async function check(manifest: Manifest | undefined): Promise<0 | 1> {
	const lines: string[] = [];
	if (manifest !== undefined) for (const problem of dependencyProblems(manifest)) lines.push(describeDependencyProblem(problem));
	for (const file of trackedSources()) {
		const source = Bun.file(path.join(root, file));
		if (!(await source.exists())) continue;
		for (const shim of shimProblems(file, await source.text())) {
			lines.push(`${shim.file}:${shim.line} declares module ${shim.module}; import the host package's own types instead`);
		}
	}
	if (lines.length === 0) {
		console.log(`${root}: dependencies follow the omomp convention`);
		return 0;
	}
	console.log(`${root}: dependencies break the omomp convention:`);
	for (const line of lines) console.log(`  ${line}`);
	return 1;
}

async function gate(manifest: Manifest | undefined, summaryFile: string | undefined): Promise<0 | 1> {
	const summary = await runGate(root, manifest);
	for (const line of renderSummary(summary)) console.log(line);
	if (summaryFile !== undefined) await Bun.write(path.resolve(summaryFile), summaryJson(summary));
	return summary.failures.length === 0 ? 0 : 1;
}

const manifest = await readManifest();
switch (command.kind) {
	case "host":
		if (manifest !== undefined) for (const name of hostPackages(manifest)) console.log(name);
		process.exit(0);
		break;
	case "check":
		process.exit(await check(manifest));
		break;
	case "gate":
		process.exit(await gate(manifest, command.summary));
}
