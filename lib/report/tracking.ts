import { createHash } from "node:crypto";
import type { Issue } from "../github.ts";
import { type CheckRun, type FailedAt, STAGE_COMMANDS, type Versions } from "./check-run.ts";

export const SCOPES = ["repo", "shared"] as const;
export type Scope = (typeof SCOPES)[number];

export type Failure = Extract<CheckRun, { readonly kind: "failed" }>;

export type Tracked = {
	readonly number: number;
	readonly url: string;
	readonly body: string;
	readonly fingerprint: string | undefined;
	readonly firstFailed: string | undefined;
};

export type FailedObservation = { readonly kind: "failed"; readonly failure: Failure; readonly fingerprint: string };

export type Observation = { readonly kind: "passed" } | FailedObservation;

export type Action =
	| { readonly kind: "create"; readonly failed: FailedObservation }
	| { readonly kind: "update-and-comment"; readonly issue: Tracked; readonly failed: FailedObservation }
	| { readonly kind: "refresh-body"; readonly issue: Tracked; readonly failed: FailedObservation }
	| { readonly kind: "close"; readonly issue: Tracked }
	| { readonly kind: "noop" };

export type Context = {
	readonly subject: string;
	readonly scope: Scope;
	readonly runUrl: string | undefined;
	readonly now: Date;
};

const FINGERPRINT = /<!-- omomp-upstream-check-fingerprint:([0-9a-f]+) -->/;
const FIRST_FAILED = /<!-- omomp-upstream-check-first-failed:(\S+) -->/;
const LATEST_FAILED_ROW = /^\| 最近一次失败 \|.*\|$/m;
const LATEST_RUN_ROW = /^\| 最近一次 run \|.*\|$/m;
const HEADLINE_PACKAGE = "@oh-my-pi/pi-coding-agent";
const GMT9_OFFSET_MS = 9 * 60 * 60 * 1000;

export function markerOf(scope: Scope): string {
	return `<!-- omomp-upstream-check:v1:${scope} -->`;
}

export function findTracked(issues: readonly Issue[], scope: Scope): Tracked | undefined {
	const marker = markerOf(scope);
	const [issue] = issues.filter((candidate) => candidate.body.includes(marker)).sort((left, right) => left.number - right.number);
	if (issue === undefined) return undefined;
	return {
		number: issue.number,
		url: issue.url,
		body: issue.body,
		fingerprint: FINGERPRINT.exec(issue.body)?.[1],
		firstFailed: FIRST_FAILED.exec(issue.body)?.[1],
	};
}

function stageName(at: FailedAt): string {
	return at.kind === "stage" ? at.stage : "setup";
}

function versionList(versions: Versions): string {
	return versions.source === "none" ? "" : versions.packages.map((p) => `${p.name}@${p.version}`).join(",");
}

export function fingerprintOf(failure: Failure, versions: Versions): string {
	return createHash("sha256")
		.update(`${stageName(failure.at)}\n${failure.head}\n${versionList(versions)}`)
		.digest("hex")
		.slice(0, 16);
}

export function decide(observation: Observation, tracked: Tracked | undefined): Action {
	switch (observation.kind) {
		case "passed":
			return tracked === undefined ? { kind: "noop" } : { kind: "close", issue: tracked };
		case "failed":
			if (tracked === undefined) return { kind: "create", failed: observation };
			return tracked.fingerprint === observation.fingerprint
				? { kind: "refresh-body", issue: tracked, failed: observation }
				: { kind: "update-and-comment", issue: tracked, failed: observation };
	}
}

export function observe(run: CheckRun, versions: Versions): Observation {
	return run.kind === "passed" ? run : { kind: "failed", failure: run, fingerprint: fingerprintOf(run, versions) };
}

export function formatTime(date: Date): string {
	const minute = (value: Date): string => value.toISOString().slice(0, 16).replace("T", " ");
	return `${minute(date)} UTC / ${minute(new Date(date.getTime() + GMT9_OFFSET_MS))} GMT+9`;
}

function stageText(at: FailedAt): string {
	return at.kind === "stage" ? `\`${at.stage}\`（\`${STAGE_COMMANDS[at.stage]}\`）` : "setup（检查阶段之外的 workflow 步骤）";
}

function fence(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	return "`".repeat(Math.max(3, longest + 1));
}

function block(text: string): string {
	const mark = fence(text);
	return `${mark}text\n${text}\n${mark}`;
}

function runText(ctx: Context): string {
	return ctx.runUrl ?? "（本地运行，没有 Actions run）";
}

const SOURCE_TEXT: Readonly<Record<Versions["source"], string>> = {
	"gate-summary": "`deps.ts gate --summary`",
	node_modules: "已安装的 `node_modules/@oh-my-pi`",
	"bun.lock": "`bun.lock`（安装或升级之前或之中失败，按锁文件兜底）",
	"package.json": "`package.json`（安装或升级之前或之中失败且没有 `bun.lock`，按声明兜底）",
	none: "无",
};

export function versionTable(versions: Versions): string {
	if (versions.source === "none" || versions.packages.length === 0) {
		return `来源：${SOURCE_TEXT[versions.source]}\n\n没有取到 \`@oh-my-pi/*\` 版本。`;
	}
	const rows = versions.packages.map((p) => `| \`${p.name}\` | \`${p.version}\` |`);
	return [`来源：${SOURCE_TEXT[versions.source]}`, "", "| 包 | 版本 |", "|---|---|", ...rows].join("\n");
}

function headlineVersion(versions: Versions): string {
	if (versions.source === "none") return "版本未知";
	const headline = versions.packages.find((p) => p.name === HEADLINE_PACKAGE) ?? versions.packages[0];
	return headline === undefined ? "版本未知" : `${headline.name}@${headline.version}`;
}

export function titleOf(ctx: Context, failure: Failure, versions: Versions): string {
	return `omomp-check 失败：${ctx.subject} · ${stageName(failure.at)} · ${headlineVersion(versions)}`;
}

export function bodyOf(input: {
	readonly ctx: Context;
	readonly failure: Failure;
	readonly versions: Versions;
	readonly fingerprint: string;
	readonly firstFailed: string;
}): string {
	const { ctx, failure, versions, fingerprint, firstFailed } = input;
	return [
		markerOf(ctx.scope),
		`<!-- omomp-upstream-check-fingerprint:${fingerprint} -->`,
		`<!-- omomp-upstream-check-first-failed:${firstFailed} -->`,
		"",
		`\`${ctx.subject}\` 的每日 omomp-check 失败。这条 issue 由检查 workflow 维护：同一失败只刷新本文的时间，失败变化时追加评论，检查恢复通过后自动关闭。`,
		"",
		"| 项 | 值 |",
		"|---|---|",
		`| 首个失败阶段 | ${stageText(failure.at)} |`,
		`| 首次失败 | ${formatTime(new Date(firstFailed))} |`,
		latestFailedRow(ctx),
		latestRunRow(ctx),
		`| 失败指纹 | \`${fingerprint}\` |`,
		"",
		"## 错误头",
		"",
		block(failure.head),
		"",
		"## @oh-my-pi 版本",
		"",
		versionTable(versions),
		"",
		"## 错误输出（截断）",
		"",
		block(failure.excerpt),
		"",
	].join("\n");
}

function latestFailedRow(ctx: Context): string {
	return `| 最近一次失败 | ${formatTime(ctx.now)} |`;
}

function latestRunRow(ctx: Context): string {
	return `| 最近一次 run | ${runText(ctx)} |`;
}

export function refreshedBody(body: string, ctx: Context): string | undefined {
	if (!LATEST_FAILED_ROW.test(body) || !LATEST_RUN_ROW.test(body)) return undefined;
	return body.replace(LATEST_FAILED_ROW, () => latestFailedRow(ctx)).replace(LATEST_RUN_ROW, () => latestRunRow(ctx));
}
export function changeComment(input: {
	readonly ctx: Context;
	readonly failure: Failure;
	readonly versions: Versions;
	readonly previous: string | undefined;
	readonly fingerprint: string;
}): string {
	const { ctx, failure, versions, previous, fingerprint } = input;
	return [
		`失败状态变化（${formatTime(ctx.now)}）：首个失败阶段 ${stageText(failure.at)}，指纹 \`${previous ?? "无"}\` → \`${fingerprint}\`。`,
		"",
		`run：${runText(ctx)}`,
		"",
		block(failure.head),
		"",
		versionTable(versions),
		"",
	].join("\n");
}

export function recoveryComment(ctx: Context, versions: Versions): string {
	return [
		`检查已恢复通过（${formatTime(ctx.now)}），关闭这条 issue。`,
		"",
		`通过的 run：${runText(ctx)}`,
		"",
		versionTable(versions),
		"",
	].join("\n");
}
