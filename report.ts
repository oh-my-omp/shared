import { appendFileSync } from "node:fs";
import path from "node:path";
import { GitHub } from "./lib/github.ts";
import {
	type CheckRun,
	hostVersions,
	JOB_STATUSES,
	type JobStatus,
	observeRun,
	parseSteps,
	readGateSummary,
	type Versions,
} from "./lib/report/check-run.ts";
import {
	bodyOf,
	type Context,
	changeComment,
	decide,
	findTracked,
	type Observation,
	observe,
	recoveryComment,
	refreshedBody,
	SCOPES,
	type Scope,
	titleOf,
	versionTable,
} from "./lib/report/tracking.ts";

const USAGE =
	"usage: OMOMP_STEPS='<toJSON(steps)>' bun report.ts --root <repository root> --logs <stage log dir> --scope repo|shared --job-status success|failure [--summary <gate summary file>] [--issue-repo <owner>/<repo>]";

type Target = { readonly owner: string; readonly repo: string };

type Options = {
	readonly root: string;
	readonly logs: string;
	readonly scope: Scope;
	readonly jobStatus: JobStatus;
	readonly summary: string | undefined;
	readonly target: Target | undefined;
};

type Outcome =
	| { readonly kind: "summary-only" }
	| { readonly kind: "created"; readonly issue: string }
	| { readonly kind: "commented"; readonly issue: string; readonly comment: string }
	| { readonly kind: "updated-body-only"; readonly issue: string }
	| { readonly kind: "closed"; readonly issue: string; readonly comment: string }
	| { readonly kind: "noop" }
	| { readonly kind: "failed"; readonly reason: string };

function describe(o: Outcome): string {
	switch (o.kind) {
		case "summary-only":
			return "summary only: no --issue-repo, no issue read or written";
		case "created":
			return `created ${o.issue}`;
		case "commented":
			return `commented ${o.comment} and updated ${o.issue}: the failure changed`;
		case "updated-body-only":
			return `updated-body-only ${o.issue}: same failure, timestamp refreshed`;
		case "closed":
			return `closed ${o.issue} after ${o.comment}: the check passes`;
		case "noop":
			return "noop: the check passes and no tracking issue is open";
		case "failed":
			return `failed: ${o.reason}`;
	}
}

function usage(reason: string): never {
	console.error(`report.ts: ${reason}\n${USAGE}`);
	process.exit(2);
}

function oneOf<T extends string>(values: readonly T[], value: string, flag: string): T {
	const found = values.find((candidate) => candidate === value);
	if (found === undefined) usage(`${flag} must be one of ${values.join(", ")}, got '${value}'`);
	return found;
}

function parseArgs(argv: readonly string[]): Options {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === undefined || value === undefined) usage(`missing value for ${flag}`);
		if (!["--root", "--logs", "--scope", "--job-status", "--summary", "--issue-repo"].includes(flag)) usage(`unknown argument ${flag}`);
		values.set(flag, value);
	}
	const required = (flag: string): string => values.get(flag) ?? usage(`${flag} is required`);
	const issueRepo = values.get("--issue-repo");
	const parts = issueRepo?.split("/");
	if (parts !== undefined && (parts.length !== 2 || parts.some((part) => part === ""))) usage(`--issue-repo must be <owner>/<repo>, got '${issueRepo}'`);
	return {
		root: path.resolve(required("--root")),
		logs: path.resolve(required("--logs")),
		scope: oneOf(SCOPES, required("--scope"), "--scope"),
		jobStatus: oneOf(JOB_STATUSES, required("--job-status"), "--job-status"),
		summary: values.get("--summary"),
		target: parts === undefined ? undefined : { owner: parts[0] ?? "", repo: parts[1] ?? "" },
	};
}

function runUrl(): string | undefined {
	const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: id } = process.env;
	return server && repository && id ? `${server}/${repository}/actions/runs/${id}` : undefined;
}

function runLine(run: CheckRun): string {
	if (run.kind === "passed") return "check passed";
	return `failed at ${run.at.kind === "stage" ? run.at.stage : "setup"}: ${run.head}`;
}

function stepSummary(ctx: Context, observation: Observation, versions: Versions): string {
	const status =
		observation.kind === "passed"
			? "检查通过。"
			: `检查失败：首个失败阶段 \`${observation.failure.at.kind === "stage" ? observation.failure.at.stage : "setup"}\`，指纹 \`${observation.fingerprint}\`。\n\n错误头：${observation.failure.head}`;
	return [`## omomp-check（${ctx.subject}）`, "", status, "", versionTable(versions), ""].join("\n");
}

async function track(gh: GitHub, target: Target, ctx: Context, observation: Observation, versions: Versions): Promise<Outcome> {
	const action = decide(observation, findTracked(await gh.openIssues(target.repo), ctx.scope));
	switch (action.kind) {
		case "noop":
			return { kind: "noop" };
		case "close": {
			const comment = await gh.commentIssue(target.repo, action.issue.number, recoveryComment(ctx, versions));
			await gh.updateIssue(target.repo, action.issue.number, { state: "closed", state_reason: "completed" });
			return { kind: "closed", issue: action.issue.url, comment };
		}
		case "create": {
			const { failure, fingerprint } = action.failed;
			const body = bodyOf({ ctx, failure, versions, fingerprint, firstFailed: ctx.now.toISOString() });
			return { kind: "created", issue: (await gh.createIssue(target.repo, { title: titleOf(ctx, failure, versions), body })).url };
		}
		case "update-and-comment": {
			const { failure, fingerprint } = action.failed;
			const firstFailed = action.issue.firstFailed ?? ctx.now.toISOString();
			await gh.updateIssue(target.repo, action.issue.number, {
				title: titleOf(ctx, failure, versions),
				body: bodyOf({ ctx, failure, versions, fingerprint, firstFailed }),
			});
			const comment = await gh.commentIssue(
				target.repo,
				action.issue.number,
				changeComment({ ctx, failure, versions, previous: action.issue.fingerprint, fingerprint }),
			);
			return { kind: "commented", issue: action.issue.url, comment };
		}
		case "refresh-body": {
			const { failure, fingerprint } = action.failed;
			const firstFailed = action.issue.firstFailed ?? ctx.now.toISOString();
			const body = refreshedBody(action.issue.body, ctx) ?? bodyOf({ ctx, failure, versions, fingerprint, firstFailed });
			await gh.updateIssue(target.repo, action.issue.number, { body });
			return { kind: "updated-body-only", issue: action.issue.url };
		}
	}
}

const options = parseArgs(Bun.argv.slice(2));
const steps = parseSteps(process.env.OMOMP_STEPS ?? "");
if (!steps.ok) usage(`OMOMP_STEPS: ${steps.reason}`);
const gateSummary = options.summary === undefined ? undefined : readGateSummary(options.summary);
const run = observeRun({ steps: steps.steps, jobStatus: options.jobStatus, logs: options.logs, gateSummary });
const versions = hostVersions(options.root, steps.steps, gateSummary);
const ctx: Context = {
	subject: process.env.GITHUB_REPOSITORY || path.basename(options.root),
	scope: options.scope,
	runUrl: runUrl(),
	now: new Date(),
};
const observation = observe(run, versions);
const packages = versions.source === "none" ? "none" : versions.packages.map((p) => `${p.name}@${p.version}`).join(", ") || "none";
console.log(`omomp-report: ${ctx.subject} (scope ${ctx.scope}): ${runLine(run)}`);
console.log(`omomp-report: @oh-my-pi versions from ${versions.source}: ${packages}`);
if (observation.kind === "failed") console.log(`omomp-report: fingerprint ${observation.fingerprint}`);
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) appendFileSync(summaryFile, stepSummary(ctx, observation, versions));

let outcome: Outcome;
if (options.target === undefined) {
	outcome = { kind: "summary-only" };
} else {
	const token = process.env.GH_TOKEN;
	if (!token) usage("GH_TOKEN is not set; --issue-repo needs a token that can write issues there");
	console.log(`omomp-report: issue writing on: ${options.target.owner}/${options.target.repo}, scope ${ctx.scope}`);
	try {
		outcome = await track(new GitHub(token, options.target.owner), options.target, ctx, observation, versions);
	} catch (error) {
		outcome = { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}
console.log(`omomp-report: ${describe(outcome)}`);
process.exit(outcome.kind === "failed" ? 1 : 0);
