import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LANGUAGE_ENV, language, languageFrom, parseLanguage, tr } from "../src/i18n.ts";

const I18N_PATH = path.join(import.meta.dir, "..", "src", "i18n.ts");
const scratch = mkdtempSync(path.join(tmpdir(), "omomp-shared-i18n-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const LANGUAGE_ENV_KEYS = [LANGUAGE_ENV, "LC_ALL", "LC_MESSAGES", "LANG"] as const;
type LanguageEnvKey = (typeof LANGUAGE_ENV_KEYS)[number];

function withLanguageEnv(vars: Partial<Record<LanguageEnvKey, string>>, run: () => void): void {
	const saved = LANGUAGE_ENV_KEYS.map((key) => [key, process.env[key]] as const);
	try {
		for (const key of LANGUAGE_ENV_KEYS) {
			const value = vars[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

let childIndex = 0;

async function runChild(script: string, env: Record<string, string | undefined>): Promise<string> {
	const file = path.join(scratch, `child-${childIndex++}.ts`);
	writeFileSync(file, script);
	const childEnv = { ...process.env };
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}
	const proc = Bun.spawn([process.execPath, file], { env: childEnv, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if (exitCode !== 0) throw new Error(`child process exited ${exitCode}: ${stderr}`);
	return stdout.trim();
}

describe("parseLanguage", () => {
	test.each([
		["en", "en"],
		[" ZH ", "zh"],
		["En", "en"],
		["", undefined],
		["zh-CN", undefined],
		["ja", undefined],
		[undefined, undefined],
	] as const)("parseLanguage(%j) is %j", (value, expected) => {
		expect(parseLanguage(value)).toBe(expected);
	});
});

describe("languageFrom", () => {
	test.each([
		["OMOMP_LANG with space and upper case", { OMOMP_LANG: " ZH " }, "zh"],
		["unparseable OMOMP_LANG falls through to LANG", { OMOMP_LANG: "zh-CN", LANG: "en_US.UTF-8" }, "en"],
		["unparseable OMOMP_LANG falls through to a zh LC_ALL", { OMOMP_LANG: "fr", LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, "zh"],
		["empty LC_ALL falls through to LC_MESSAGES", { LC_ALL: "", LC_MESSAGES: "zh_CN.UTF-8" }, "zh"],
		["blank LC_ALL counts as empty", { LC_ALL: "  ", LC_MESSAGES: "zh_CN.UTF-8" }, "zh"],
		["non-zh LC_ALL beats a zh LANG", { LC_ALL: "C", LANG: "zh_CN.UTF-8" }, "en"],
		["zh detection is case-insensitive", { LANG: "ZH_CN.UTF-8" }, "zh"],
		["nothing set is English", {}, "en"],
	] as const)("%s", (_name, env, expected) => {
		expect(languageFrom(env)).toBe(expected);
	});

	test("consults only the given map, never process.env", () => {
		withLanguageEnv({ OMOMP_LANG: "zh", LANG: "zh_CN.UTF-8" }, () => {
			expect(languageFrom({ LANG: "en_US.UTF-8" })).toBe("en");
			expect(languageFrom({})).toBe("en");
		});
	});
});

describe("language", () => {
	test("re-reads the environment on every call", () => {
		withLanguageEnv({ OMOMP_LANG: "en" }, () => {
			expect(language()).toBe("en");
			process.env[LANGUAGE_ENV] = "zh";
			expect(language()).toBe("zh");
		});
	});
});

describe("tr", () => {
	test("selects the text for the current language", () => {
		withLanguageEnv({ OMOMP_LANG: "en" }, () => {
			expect(tr("open", "打开")).toBe("open");
		});
		withLanguageEnv({ OMOMP_LANG: "zh" }, () => {
			expect(tr("open", "打开")).toBe("打开");
		});
	});
});

describe("child processes", () => {
	test("importing the module does not evaluate the environment", async () => {
		const output = await runChild(
			`import { language } from ${JSON.stringify(I18N_PATH)};\nprocess.env.OMOMP_LANG = "en";\nconsole.log(language());\n`,
			{ OMOMP_LANG: "zh" },
		);
		expect(output).toBe("en");
	});

	test("the agent-dir omomp file is never read", async () => {
		const agentDir = path.join(scratch, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "omomp.yml"), "omomp-lang: {language: zh}\n");
		const output = await runChild(`import { language } from ${JSON.stringify(I18N_PATH)};\nconsole.log(language());\n`, {
			PI_CODING_AGENT_DIR: agentDir,
			HOME: agentDir,
			LANG: "en_US.UTF-8",
			OMOMP_LANG: undefined,
			LC_ALL: undefined,
			LC_MESSAGES: undefined,
		});
		expect(output).toBe("en");
	});
});
