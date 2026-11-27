import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { declaredHostPackages, installedHostPackages, lockedHostPackages } from "../lib/host-packages.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "omomp-host-packages-"));

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(scratch, "repo-"));
	for (const [relative, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
		writeFileSync(path.join(root, relative), text);
	}
	return root;
}

describe("installedHostPackages", () => {
	test("returns no packages when the @oh-my-pi scope directory is absent", () => {
		expect(installedHostPackages(repository({}))).toEqual([]);
	});

	test("keeps directories whose manifest names them, dropping .ignored_* leftovers, aliases and broken manifests", () => {
		const root = repository({
			"node_modules/@oh-my-pi/zzz/package.json": JSON.stringify({ name: "@oh-my-pi/alpha", version: "1.0.0" }),
			"node_modules/@oh-my-pi/no-version/package.json": JSON.stringify({ name: "@oh-my-pi/no-version" }),
			"node_modules/@oh-my-pi/alpha/package.json": JSON.stringify({ name: "@oh-my-pi/alpha", version: "1.0.0" }),
			"node_modules/@oh-my-pi/zeta/package.json": JSON.stringify({ name: "@oh-my-pi/zeta", version: "2.3.4" }),
			"node_modules/@oh-my-pi/.ignored_zeta/package.json": JSON.stringify({ name: "@oh-my-pi/zeta", version: "0.9.0" }),
			"node_modules/@oh-my-pi/loose-file": "",
		});
		symlinkSync(path.join(root, "node_modules/@oh-my-pi/alpha"), path.join(root, "node_modules/@oh-my-pi/alias"));
		expect(installedHostPackages(root)).toEqual([
			{ name: "@oh-my-pi/alpha", version: "1.0.0" },
			{ name: "@oh-my-pi/zeta", version: "2.3.4" },
		]);
	});
});

describe("lockedHostPackages", () => {
	test("reads the resolved version of each top-level @oh-my-pi package from a JSONC bun.lock", () => {
		const lock = `{
			"lockfileVersion": 1,
			"workspaces": { "": { "devDependencies": { "@oh-my-pi/pi-utils": "latest" } } },
			"packages": {
				"@oh-my-pi/pi-utils": ["@oh-my-pi/pi-utils@19.1.0", "", {}, "sha512-x"],
				"@oh-my-pi/omptype": ["@oh-my-pi/omptype@19.1.0", "", {}, "sha512-y"],
				"@oh-my-pi/pi-coding-agent/@oh-my-pi/pi-utils": ["@oh-my-pi/pi-utils@18.0.0", "", {}, "sha512-z"],
				"zod": ["zod@4.0.0", "", {}, "sha512-w"],
			},
		}`;
		expect(lockedHostPackages(repository({ "bun.lock": lock }))).toEqual([
			{ name: "@oh-my-pi/omptype", version: "19.1.0" },
			{ name: "@oh-my-pi/pi-utils", version: "19.1.0" },
		]);
	});

	test("returns undefined when bun.lock is absent or unreadable, so the caller falls back to package.json", () => {
		expect(lockedHostPackages(repository({}))).toBeUndefined();
		expect(lockedHostPackages(repository({ "bun.lock": "{ not json" }))).toBeUndefined();
	});
});

describe("declaredHostPackages", () => {
	test("lists each declared @oh-my-pi package with its spec, the first section declaring it winning", () => {
		const manifest = {
			dependencies: { "@oh-my-pi/pi-utils": "latest", left: "latest" },
			devDependencies: { "@oh-my-pi/omptype": "latest", "@oh-my-pi/pi-utils": "1.0.0" },
			peerDependencies: { "@oh-my-pi/pi-coding-agent": "*" },
		};
		expect(declaredHostPackages(repository({ "package.json": JSON.stringify(manifest) }))).toEqual([
			{ name: "@oh-my-pi/omptype", version: "latest" },
			{ name: "@oh-my-pi/pi-coding-agent", version: "*" },
			{ name: "@oh-my-pi/pi-utils", version: "latest" },
		]);
	});

	test("returns undefined without a readable package.json", () => {
		expect(declaredHostPackages(repository({}))).toBeUndefined();
		expect(declaredHostPackages(repository({ "package.json": "[]" }))).toBeUndefined();
	});
});
