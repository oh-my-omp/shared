import { statSync } from "node:fs";
import path from "node:path";
import { dependencyProblems, describeDependencyProblem, hostPackages, type Manifest, parseManifest, shimProblems } from "./lib/deps.ts";
import { describeGateProblem, toolEntryGateProblems } from "./lib/tool-entry-gate.ts";

const USAGE = "usage: bun deps.ts check|host <repository root>";

const [command, arg] = Bun.argv.slice(2);
if ((command !== "check" && command !== "host") || arg === undefined || Bun.argv.length > 4) {
	console.error(USAGE);
	process.exit(2);
}
const root = path.resolve(arg);
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
		for (const gate of toolEntryGateProblems(file, await source.text())) {
			lines.push(describeGateProblem(gate));
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

const manifest = await readManifest();
if (command === "host") {
	if (manifest !== undefined) for (const name of hostPackages(manifest)) console.log(name);
	process.exit(0);
}
process.exit(await check(manifest));
