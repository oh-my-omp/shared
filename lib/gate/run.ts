import { existsSync } from "node:fs";
import path from "node:path";
import type { Manifest } from "../deps.ts";
import { checkChainedCasts } from "./casts.ts";
import { checkCrossExtensionImports } from "./cross-extension.ts";
import { checkEntries } from "./entries.ts";
import {
	describeFailure,
	type Failure,
	type GatedShape,
	type GateFailure,
	type GateName,
	type Shape,
	type Skip,
	type SourceSet,
	type Summary,
	stageOf,
} from "./model.ts";
import { collectSources, deriveShape } from "./scope.ts";
import type { TsHost } from "./ts-project.ts";
import { openTsHost } from "./ts-project.ts";
import { checkUpstreamExports, installedHostPackages } from "./upstream.ts";

const GATES: readonly GateName[] = ["upstream-exports", "extension-entries", "cross-extension-imports", "test-presence", "chained-casts"];

function entriesOf(shape: GatedShape): readonly string[] {
	switch (shape.kind) {
		case "plugin-single":
		case "plugin-multi":
			return shape.entries;
		case "config-bundle":
		case "shared-source":
			return [];
	}
}

async function astGates(
	root: string,
	shape: GatedShape,
	sources: SourceSet,
	host: TsHost,
): Promise<{ failures: GateFailure[]; skipped: Skip[] }> {
	const entries = entriesOf(shape);
	const absolute = (file: string) => path.join(root, file);
	const production = sources.production.map(absolute);
	const project = await host.open([...new Set([...production, ...entries.map(absolute).filter((file) => existsSync(file))])]);
	const failures: GateFailure[] = [];
	const skipped: Skip[] = [];
	switch (shape.kind) {
		case "plugin-single":
		case "plugin-multi":
			failures.push(...(await checkEntries({ root, entries, project })));
			break;
		case "config-bundle":
		case "shared-source":
			skipped.push({ gate: "extension-entries", reason: `shape ${shape.kind} declares no omp.extensions entries` });
	}
	switch (shape.kind) {
		case "plugin-multi":
		case "config-bundle":
			failures.push(...(await checkCrossExtensionImports({ root, shape, production, project })));
			break;
		case "plugin-single":
		case "shared-source":
			skipped.push({ gate: "cross-extension-imports", reason: `shape ${shape.kind} holds a single extension or none` });
	}
	if (sources.tests.length === 0) failures.push({ kind: "no-tests" });
	failures.push(...(await checkChainedCasts({ root, production, project })));
	return { failures, skipped };
}

export async function runGate(root: string, manifest: Manifest | undefined): Promise<Summary> {
	const [shape, hostPackages] = await Promise.all([deriveShape(root), installedHostPackages(root)]);
	if (shape.kind === "exempt") {
		return {
			root,
			shape,
			hostPackages,
			sources: { production: 0, nonProduction: 0, tests: 0 },
			skipped: GATES.map((gate) => ({ gate, reason: shape.reason })),
			failures: [],
			nonProduction: [],
		};
	}
	const sources = await collectSources(root, shape);
	const host = openTsHost(root);
	try {
		const upstream = await checkUpstreamExports({ root, manifest, sources, host });
		const gates = await astGates(root, shape, sources, host);
		return {
			root,
			shape,
			hostPackages,
			sources: { production: sources.production.length, nonProduction: sources.nonProduction.length, tests: sources.tests.length },
			skipped: gates.skipped,
			failures: [...upstream.failures, ...gates.failures],
			nonProduction: upstream.nonProduction,
		};
	} finally {
		await host.close();
	}
}

function shapeText(shape: Shape): string {
	switch (shape.kind) {
		case "plugin-single":
		case "plugin-multi":
			return `${shape.kind} (${shape.entries.join(", ")})`;
		case "config-bundle":
		case "shared-source":
			return shape.kind;
		case "exempt":
			return `exempt: ${shape.reason}`;
	}
}

export function renderSummary(summary: Summary): string[] {
	const lines = [`${summary.root}: shape ${shapeText(summary.shape)}`];
	if (summary.shape.kind === "exempt") {
		lines.push(`${summary.root}: every gate skipped`);
		return lines;
	}
	const hosts = summary.hostPackages.map((p) => `${p.name}@${p.version}`).join(", ");
	lines.push(`  @oh-my-pi packages: ${hosts === "" ? "none installed" : hosts}`);
	lines.push(
		`  sources: ${summary.sources.production} production, ${summary.sources.nonProduction} non-production, ${summary.sources.tests} test files`,
	);
	for (const skip of summary.skipped) lines.push(`  skipped ${skip.gate}: ${skip.reason}`);
	for (const failure of summary.nonProduction) lines.push(`  non-production (not gated): ${describeFailure(failure)}`);
	for (const failure of summary.failures) lines.push(`  ${stageOf(failure)}: ${describeFailure(failure)}`);
	const count = summary.failures.length;
	lines.push(
		count === 0 ? `${summary.root}: passes the omomp gate` : `${summary.root}: ${count} gate ${count === 1 ? "failure" : "failures"}`,
	);
	return lines;
}

function failureRecord(failure: Failure) {
	return { stage: stageOf(failure), ...failure, message: describeFailure(failure) };
}

export function summaryJson(summary: Summary): string {
	return `${JSON.stringify(
		{
			...summary,
			failures: summary.failures.map(failureRecord),
			nonProduction: summary.nonProduction.map(failureRecord),
		},
		null,
		"\t",
	)}\n`;
}
