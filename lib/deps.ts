export const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export type DependencyProblem =
	| { readonly kind: "unreadable"; readonly reason: string }
	| { readonly kind: "malformed"; readonly section: DependencySection }
	| { readonly kind: "pinned"; readonly section: DependencySection; readonly name: string; readonly spec: string }
	| { readonly kind: "legacy"; readonly section: DependencySection; readonly name: string };

export type ShimProblem = { readonly file: string; readonly line: number; readonly module: string };

export type Manifest = { readonly sections: ReadonlyMap<DependencySection, ReadonlyMap<string, string>> };

const LEGACY_NAME = /^(?:@earendil-works\/|@mariozechner\/|typebox$|@sinclair\/typebox$)/;
const GIT_SPEC = /^(?:github:|gitlab:|bitbucket:|git\+|git:\/\/|git@|https?:\/\/\S+\.git(?:#|$))/;
const COMMIT_REF = /^(?:[0-9a-f]{7,40}|semver:.*)$/i;
const HOST_SCOPE = "@oh-my-pi/";
const HOST_SHIM = /declare\s+module\s+["'](@oh-my-pi\/[^"']+)["']/;

export function parseManifest(
	text: string,
): { readonly ok: true; readonly manifest: Manifest } | { readonly ok: false; readonly problems: readonly DependencyProblem[] } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, problems: [{ kind: "unreadable", reason: error instanceof Error ? error.message : String(error) }] };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, problems: [{ kind: "unreadable", reason: "package.json is not a JSON object" }] };
	}
	const problems: DependencyProblem[] = [];
	const sections = new Map<DependencySection, ReadonlyMap<string, string>>();
	for (const section of DEPENDENCY_SECTIONS) {
		const raw: unknown = Reflect.get(value, section);
		if (raw === undefined) continue;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			problems.push({ kind: "malformed", section });
			continue;
		}
		const entries = new Map<string, string>();
		for (const [name, spec] of Object.entries(raw)) {
			if (typeof spec !== "string") {
				problems.push({ kind: "malformed", section });
				continue;
			}
			entries.set(name, spec);
		}
		sections.set(section, entries);
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, manifest: { sections } };
}

function unpinnedGit(spec: string): boolean {
	if (!GIT_SPEC.test(spec)) return false;
	const hash = spec.indexOf("#");
	return hash < 0 || !COMMIT_REF.test(spec.slice(hash + 1));
}

function specAllowed(section: DependencySection, spec: string): boolean {
	switch (section) {
		case "peerDependencies":
			return spec === "*";
		case "dependencies":
		case "devDependencies":
		case "optionalDependencies":
			return spec === "latest" || unpinnedGit(spec);
	}
}

export function dependencyProblems(manifest: Manifest): DependencyProblem[] {
	const problems: DependencyProblem[] = [];
	for (const [section, entries] of manifest.sections) {
		for (const [name, spec] of entries) {
			if (LEGACY_NAME.test(name)) problems.push({ kind: "legacy", section, name });
			else if (!specAllowed(section, spec)) problems.push({ kind: "pinned", section, name, spec });
		}
	}
	return problems;
}

export function hostPackages(manifest: Manifest): string[] {
	const names = new Set<string>();
	for (const [section, entries] of manifest.sections) {
		if (section === "peerDependencies") continue;
		for (const name of entries.keys()) if (name.startsWith(HOST_SCOPE)) names.add(name);
	}
	return [...names].sort();
}

export function shimProblems(file: string, text: string): ShimProblem[] {
	const problems: ShimProblem[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		const match = HOST_SHIM.exec(line);
		if (match?.[1] !== undefined) problems.push({ file, line: index + 1, module: match[1] });
	}
	return problems;
}

export function describeDependencyProblem(problem: DependencyProblem): string {
	switch (problem.kind) {
		case "unreadable":
			return `package.json cannot be read: ${problem.reason}`;
		case "malformed":
			return `${problem.section} must map package names to version strings`;
		case "pinned":
			return `${problem.section}.${problem.name} is "${problem.spec}"; write "${problem.section === "peerDependencies" ? "*" : "latest"}"`;
		case "legacy":
			return `${problem.section}.${problem.name}: omp resolves this package to @oh-my-pi; depend on the @oh-my-pi package instead`;
	}
}
