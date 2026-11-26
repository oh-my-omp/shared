import { statSync } from "node:fs";
import path from "node:path";
import type { GateFailure } from "./model.ts";
import type { DefaultExport, TsProject } from "./ts-project.ts";

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function failureOf(entry: string, exported: DefaultExport): GateFailure | undefined {
	switch (exported.kind) {
		case "callable":
			return undefined;
		case "absent":
			return { kind: "entry-not-factory", entry, reason: "it has no default export" };
		case "not-callable":
			return { kind: "entry-not-factory", entry, reason: exported.reason };
	}
}

export async function checkEntries(input: {
	readonly root: string;
	readonly entries: readonly string[];
	readonly project: TsProject;
}): Promise<GateFailure[]> {
	const failures: GateFailure[] = [];
	for (const entry of input.entries) {
		const file = path.join(input.root, entry);
		if (!isFile(file)) {
			failures.push({ kind: "entry-missing", entry });
			continue;
		}
		const failure = failureOf(entry, await input.project.defaultExport(file));
		if (failure !== undefined) failures.push(failure);
	}
	return failures;
}
