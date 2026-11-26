export type Shape =
	| { readonly kind: "plugin-single"; readonly entries: readonly [string] }
	| { readonly kind: "plugin-multi"; readonly entries: readonly string[] }
	| { readonly kind: "config-bundle" }
	| { readonly kind: "shared-source" }
	| { readonly kind: "exempt"; readonly reason: string };

export type GatedShape = Exclude<Shape, { readonly kind: "exempt" }>;

export type SourceSet = {
	readonly production: readonly string[];
	readonly nonProduction: readonly string[];
	readonly tests: readonly string[];
};

export type HostPackage = { readonly name: string; readonly version: string };

export type ImportSite = { readonly file: string; readonly line: number; readonly specifier: string };

export type UpstreamFailure =
	| { readonly kind: "unbundled-subpath"; readonly site: ImportSite; readonly package: string }
	| { readonly kind: "undeclared-package"; readonly site: ImportSite; readonly package: string }
	| { readonly kind: "unresolved-target"; readonly site: ImportSite; readonly reason: string }
	| { readonly kind: "module-table-unavailable"; readonly reason: string }
	| { readonly kind: "missing-export"; readonly site: ImportSite; readonly symbol: string; readonly target: string }
	| { readonly kind: "type-only-export"; readonly site: ImportSite; readonly symbol: string; readonly target: string }
	| { readonly kind: "missing-type-export"; readonly site: ImportSite; readonly symbol: string; readonly target: string };

export type GateFailure =
	| { readonly kind: "entry-missing"; readonly entry: string }
	| { readonly kind: "entry-not-factory"; readonly entry: string; readonly reason: string }
	| { readonly kind: "cross-extension-import"; readonly site: ImportSite; readonly from: string; readonly to: string }
	| { readonly kind: "no-tests" }
	| { readonly kind: "unmarked-chained-cast"; readonly file: string; readonly line: number; readonly text: string };

export type Failure = UpstreamFailure | GateFailure;

export type Stage = "upstream-exports" | "ast-gates";

export type GateName = "upstream-exports" | "extension-entries" | "cross-extension-imports" | "test-presence" | "chained-casts";

export type Skip = { readonly gate: GateName; readonly reason: string };

export type Summary = {
	readonly root: string;
	readonly shape: Shape;
	readonly hostPackages: readonly HostPackage[];
	readonly sources: { readonly production: number; readonly nonProduction: number; readonly tests: number };
	readonly skipped: readonly Skip[];
	readonly failures: readonly Failure[];
	readonly nonProduction: readonly UpstreamFailure[];
};

export function stageOf(failure: Failure): Stage {
	switch (failure.kind) {
		case "unbundled-subpath":
		case "undeclared-package":
		case "unresolved-target":
		case "module-table-unavailable":
		case "missing-export":
		case "type-only-export":
		case "missing-type-export":
			return "upstream-exports";
		case "entry-missing":
		case "entry-not-factory":
		case "cross-extension-import":
		case "no-tests":
		case "unmarked-chained-cast":
			return "ast-gates";
	}
}

function at(site: ImportSite): string {
	return `${site.file}:${site.line} '${site.specifier}'`;
}

export function describeFailure(failure: Failure): string {
	switch (failure.kind) {
		case "unbundled-subpath":
			return `${at(failure.site)}: ${failure.package} is bundled into the omp binary, and this subpath is not in its module table (collectBundledPiEntries)`;
		case "undeclared-package":
			return `${at(failure.site)}: ${failure.package} is not bundled into the omp binary and package.json does not declare it`;
		case "unresolved-target":
			return `${at(failure.site)}: no runtime module: ${failure.reason}`;
		case "module-table-unavailable":
			return `the omp module table cannot be read: ${failure.reason}`;
		case "missing-export":
			return `${at(failure.site)}: '${failure.symbol}' is not exported by ${failure.target}`;
		case "type-only-export":
			return `${at(failure.site)}: '${failure.symbol}' is only a type in ${failure.target}; import it with 'import type'`;
		case "missing-type-export":
			return `${at(failure.site)}: type '${failure.symbol}' is not exported by ${failure.target}`;
		case "entry-missing":
			return `omp.extensions entry ${failure.entry} does not exist`;
		case "entry-not-factory":
			return `omp.extensions entry ${failure.entry} does not default-export a factory function: ${failure.reason}`;
		case "cross-extension-import":
			return `${at(failure.site)}: extension ${failure.from} imports extension ${failure.to}; share code through the shared directory`;
		case "no-tests":
			return "no discoverable test file (*.test.ts, *.spec.ts, *_test.ts, *_spec.ts and their .tsx/.js forms)";
		case "unmarked-chained-cast":
			return `${failure.file}:${failure.line}: chained cast '${failure.text}' has no '// SAFETY: <reason>' comment on the line above or at the end of its line`;
	}
}
