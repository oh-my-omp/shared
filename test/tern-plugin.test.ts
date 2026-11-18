import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findTern, pluginCopyMatches, readPluginManifest } from "../src/tern-plugin.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "tern-plugin-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A temp dir containing a fake executable `tern` (or `tern<ext>`) with the given contents. */
function binDir(name: string, file: string, contents: string, mode = 0o755): string {
	const dir = mkdtempSync(path.join(scratch, `${name}-`));
	writeFileSync(path.join(dir, file), contents, { mode });
	chmodSync(path.join(dir, file), mode);
	return dir;
}

/** findTern env that keeps the real environment but puts `dir` alone on PATH. */
function envWithPath(dir: string): NodeJS.ProcessEnv {
	return { ...process.env, PATH: dir };
}

const IS_WIN32 = process.platform === "win32";

describe("findTern", () => {
	test("finds an executable on PATH and returns not_installed for an empty PATH", () => {
		const dir = binDir("posix", "tern", "#!/bin/sh\nexit 0\n");
		const found = findTern({ env: envWithPath(dir) });
		expect(found).toEqual({ kind: "found", path: path.join(dir, "tern"), cli: expect.anything() });
		expect(findTern({ env: { PATH: "" } })).toEqual({ kind: "not_installed" });
	});

	test("on win32 a .bat or .cmd shim is never chosen, even first in PATHEXT", () => {
		const both = binDir("win-both", "tern.bat", "@echo off\n", 0o644);
		writeFileSync(path.join(both, "tern.cmd"), "@echo off\n", { mode: 0o644 });
		writeFileSync(path.join(both, "tern.exe"), "", { mode: 0o644 });
		const found = findTern({ env: { PATH: both, PATHEXT: ".BAT;.CMD;.EXE" }, platform: "win32" });
		expect(found).toEqual({ kind: "found", path: path.join(both, "tern.exe"), cli: expect.anything() });
		const shimOnly = binDir("win-shim", "tern.cmd", "@echo off\n", 0o644);
		expect(findTern({ env: { PATH: shimOnly, PATHEXT: ".CMD;.EXE" }, platform: "win32" })).toEqual({ kind: "not_installed" });
	});

	test("on win32 it follows PATHEXT order between .com and .exe", () => {
		const dir = binDir("win-order", "tern.com", "", 0o644);
		writeFileSync(path.join(dir, "tern.exe"), "", { mode: 0o644 });
		const found = findTern({ env: { PATH: dir, PATHEXT: ".COM;.EXE" }, platform: "win32" });
		expect(found).toEqual({ kind: "found", path: path.join(dir, "tern.com"), cli: expect.anything() });
	});

	test("on win32 it finds tern.exe even when PATHEXT omits .EXE", () => {
		const dir = binDir("win-exe", "tern.exe", "", 0o644);
		const found = findTern({ env: { PATH: dir, PATHEXT: ".CMD" }, platform: "win32" });
		expect(found).toEqual({ kind: "found", path: path.join(dir, "tern.exe"), cli: expect.anything() });
	});

	test("on win32 an unset PATHEXT falls back to the executable extensions", () => {
		const dir = binDir("win-default", "tern.exe", "", 0o644);
		const found = findTern({ env: { PATH: dir }, platform: "win32" });
		expect(found).toEqual({ kind: "found", path: path.join(dir, "tern.exe"), cli: expect.anything() });
	});

	test("a directory named tern is not an executable", () => {
		const dir = mkdtempSync(path.join(scratch, "notfile-"));
		mkdirSync(path.join(dir, "tern"));
		expect(findTern({ env: envWithPath(dir) })).toEqual({ kind: "not_installed" });
	});
});

// Fixture captured verbatim from `tern plugin list --json` on macOS (2026-11-19),
// trimmed to one entry and extended with the disabled and failed status shapes.
const LIST_JSON = `{
  "plugins": [
    {
      "id": "omp-playbooks",
      "name": "Playbooks",
      "version": "0.1.51",
      "description": "Open a Playbook's document view in a pane.",
      "icon": "file",
      "css": "",
      "blocks": [],
      "lenses": [],
      "host": false,
      "window": true,
      "status": "ready"
    },
    {
      "id": "disabled-one",
      "version": "1.0.0",
      "css": "body {}",
      "status": "disabled"
    },
    {
      "id": "broken-one",
      "version": "2.0.0",
      "css": "",
      "status": { "failed": "syntax error in window.luau" }
    }
  ],
  "problems": [],
  "jit": false,
  "canvas": true
}`;

// Fixture captured verbatim from `tern plugin dir --json` on macOS (2026-11-19).
const DIR_JSON = `{\n  "dir": "/Users/mouriya/Library/Application Support/Tern/plugins"\n}`;

/** A fake `tern` script: argv[2] selects the verb, the case decides the answer. PATH keeps the
 * standard bins the script's commands (`cat`, `sleep`) need — no real `tern` lives there. */
function fakeTern(name: string, script: string): NodeJS.ProcessEnv {
	const dir = binDir(name, "tern", `#!/bin/sh\n${script}`);
	return { ...process.env, PATH: `${dir}:/usr/bin:/bin` };
}

const DISPATCHING_TERN = `case "$2" in
dir) printf '%s\\n' '${DIR_JSON.replace(/'/g, "'\\''")}' ;;
list) cat <<'EOF'
${LIST_JSON}
EOF
;;
*) printf 'tern plugin: unknown verb\\n' >&2; exit 3 ;;
esac`;

const ternIt = IS_WIN32 ? test.skip : test;

describe("TernPluginCli", () => {
	ternIt("dir parses the real answer shape into an absolute path", async () => {
		const found = findTern({ env: fakeTern("dir", DISPATCHING_TERN) });
		if (found.kind !== "found") throw new Error("fake tern not found");
		const result = await found.cli.dir();
		expect(result).toEqual({ ok: true, value: "/Users/mouriya/Library/Application Support/Tern/plugins" });
	});

	ternIt("list parses id, version, css and all three status shapes", async () => {
		const found = findTern({ env: fakeTern("list", DISPATCHING_TERN) });
		if (found.kind !== "found") throw new Error("fake tern not found");
		const result = await found.cli.list();
		expect(result).toEqual({
			ok: true,
			value: [
				{ id: "omp-playbooks", version: "0.1.51", css: "", status: { kind: "ready" } },
				{ id: "disabled-one", version: "1.0.0", css: "body {}", status: { kind: "disabled" } },
				{ id: "broken-one", version: "2.0.0", css: "", status: { kind: "failed", detail: "syntax error in window.luau" } },
			],
		});
	});

	ternIt("malformed list JSON is a list-stage error", async () => {
		const found = findTern({ env: fakeTern("bad-list", "printf 'not json\\n'\n") });
		if (found.kind !== "found") throw new Error("fake tern not found");
		const result = await found.cli.list();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.stage).toBe("list");
	});

	ternIt("a valid JSON answer of the wrong shape is a dir-stage error", async () => {
		const found = findTern({ env: fakeTern("bad-dir", 'printf \'{"dir":"relative/path"}\\n\'\n') });
		if (found.kind !== "found") throw new Error("fake tern not found");
		const result = await found.cli.dir();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.stage).toBe("dir");
	});

	ternIt("a non-zero exit reports the verb's stage and stderr", async () => {
		const found = findTern({ env: fakeTern("fail", DISPATCHING_TERN) });
		if (found.kind !== "found") throw new Error("fake tern not found");
		const result = await found.cli.remove("nope");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.stage).toBe("remove");
			expect(result.error.message).toContain("exited 3");
			expect(result.error.message).toContain("unknown verb");
		}
	});

	ternIt("a hanging tern is cut off by the timeout", async () => {
		const found = findTern({ env: fakeTern("sleep", "sleep 30\n"), timeoutMs: 300 });
		if (found.kind !== "found") throw new Error("fake tern not found");
		const started = Date.now();
		const result = await found.cli.list();
		expect(result.ok).toBe(false);
		expect(Date.now() - started).toBeLessThan(10_000);
		if (!result.ok) {
			expect(result.error.stage).toBe("list");
			expect(result.error.message).toContain("timed out");
		}
	});
});

describe("readPluginManifest", () => {
	function packageDir(id: string): string {
		const dir = mkdtempSync(path.join(scratch, "pkg-"));
		writeFileSync(path.join(dir, "plugin.toml"), `id = "${id}"\nversion = "1.2.3"\n`);
		return dir;
	}

	test("returns the declared id and version when it matches", async () => {
		const result = await readPluginManifest(packageDir("omp-probe"), "omp-probe");
		expect(result).toEqual({ ok: true, value: { id: "omp-probe", version: "1.2.3" } });
	});

	test("a foreign id is a verify-stage error", async () => {
		const result = await readPluginManifest(packageDir("other"), "omp-probe");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.stage).toBe("verify");
			expect(result.error.message).toContain('"other"');
		}
	});

	test("a missing or unparseable manifest is a verify-stage error", async () => {
		const missing = await readPluginManifest(mkdtempSync(path.join(scratch, "empty-")), "x");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.stage).toBe("verify");

		const dir = mkdtempSync(path.join(scratch, "badtoml-"));
		writeFileSync(path.join(dir, "plugin.toml"), "id = [unclosed\n");
		const bad = await readPluginManifest(dir, "x");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error.stage).toBe("verify");
	});
});

describe("pluginCopyMatches", () => {
	function tree(name: string, files: Record<string, string | Uint8Array>): string {
		const dir = mkdtempSync(path.join(scratch, `${name}-`));
		for (const [rel, content] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
			writeFileSync(path.join(dir, rel), content);
		}
		return dir;
	}

	test("identical trees match; a one-byte change does not", async () => {
		const files = { "plugin.toml": 'id = "x"\n', "window.luau": "return {}\n" };
		const pkg = tree("pkg", files);
		const copy = tree("copy", files);
		expect(await pluginCopyMatches(pkg, copy)).toEqual({ ok: true, value: true });

		const changed = tree("changed", { ...files, "window.luau": "return {}\x00" });
		expect(await pluginCopyMatches(pkg, changed)).toEqual({ ok: true, value: false });
	});

	test("extra files, missing files and a missing installed dir do not match", async () => {
		const files = { "a.txt": "a" };
		const pkg = tree("pkg2", files);
		const extra = tree("extra", { ...files, "b.txt": "b" });
		const absent = path.join(scratch, "never-created");
		expect(await pluginCopyMatches(pkg, extra)).toEqual({ ok: true, value: false });
		expect(await pluginCopyMatches(pkg, absent)).toEqual({ ok: true, value: false });
	});
});
