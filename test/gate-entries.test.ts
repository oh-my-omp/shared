import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkEntries } from "../lib/gate/entries.ts";
import { openTsHost } from "../lib/gate/ts-project.ts";

const root = mkdtempSync(path.join(tmpdir(), "omomp-gate-entries-"));

function fixture(relative: string, text: string): string {
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
	return file;
}

fixture(
	"tsconfig.json",
	JSON.stringify({
		compilerOptions: {
			target: "ESNext",
			module: "Preserve",
			moduleResolution: "bundler",
			strict: true,
			noEmit: true,
			allowImportingTsExtensions: true,
		},
		include: [],
	}),
);

const files = [
	fixture("factory.ts", "export default function factory(pi: unknown) {\n\tvoid pi;\n}\n"),
	fixture("extensions/demo/index.ts", "export default (pi: unknown) => {\n\tvoid pi;\n};\n"),
	fixture("assigned.ts", "const f = () => 1;\nexport default f;\n"),
	fixture("named-only.ts", "export const named = 1;\nexport type Named = string;\n"),
	fixture("object.ts", "const thing = { a: 1 };\nexport default thing;\n"),
];

const host = openTsHost(root);
const project = await host.open(files);
afterAll(async () => {
	await host.close();
	rmSync(root, { recursive: true, force: true });
});

describe("checkEntries", () => {
	test("reports non-factory and missing entries in entry order", async () => {
		const failures = await checkEntries({
			root,
			entries: ["named-only.ts", "object.ts", "extensions/demo/missing.ts"],
			project,
		});
		expect(failures.map((failure) => failure.kind)).toEqual(["entry-not-factory", "entry-not-factory", "entry-missing"]);
		expect(failures[0]).toEqual({ kind: "entry-not-factory", entry: "named-only.ts", reason: "it has no default export" });
		const objectFailure = failures[1];
		if (objectFailure?.kind !== "entry-not-factory") throw new Error("expected a non-factory failure for the object default");
		expect(objectFailure.entry).toBe("object.ts");
		expect(objectFailure.reason.startsWith("its type is")).toBe(true);
		expect(failures[2]).toEqual({ kind: "entry-missing", entry: "extensions/demo/missing.ts" });
	});

	test("accepts function, arrow and assigned-function default exports", async () => {
		expect(
			await checkEntries({
				root,
				entries: ["factory.ts", "extensions/demo/index.ts", "assigned.ts"],
				project,
			}),
		).toEqual([]);
	});
});
