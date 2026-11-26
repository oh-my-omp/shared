# shared

Single source of the code that several oh-my-omp repositories copy: each consumer declares the files it uses in `omomp-shared.json`, a push sync opens PRs with the copies, and each repository's check compares them byte for byte.

`deps.ts` is the dependency check every repository's check runs: `bun deps.ts check <root>` fails on a pinned dependency, a non-`*` peer, a legacy pi or typebox package, or a tracked `declare module "@oh-my-pi/…"`; `bun deps.ts host <root>` lists the `@oh-my-pi` packages the check upgrades to their newest release before type-checking.

`bun deps.ts gate <root> [--summary <file>]` checks a repository against the omp host it installed: run it after `bun install` and the host upgrade, from a checkout of this repository whose own dependencies are installed (it uses this repository's `typescript`).

- **Shape:** the repository's shape comes from what it already declares, with no list kept anywhere: `shared-source` (`package.json` named `omomp-shared` with `src/`), `config-bundle` (`agent/extensions/` with `agent/extensions/_shared/package.json`), `plugin-single` or `plugin-multi` (one or several `omp.extensions` entries), otherwise `exempt`. An exempt repository passes with the reason printed and no gate run.
- **Sources:** TypeScript files outside `node_modules/`, `dist/` and dot-directories; a `config-bundle` is scanned under `agent/extensions/` and `agent/extensions-last/` only. Files under `test/`, `tests/`, `eval/`, `bench/`, `demo/`, `research/`, `sandbox/` and `*.test.*` / `*.spec.*` files are non-production.
- **Upstream exports:** every `@oh-my-pi/*` value import, `export … from` and literal `import()` in production code must load in the omp binary. A package bundled into the binary must be imported through a key of its module table (`collectBundledPiEntries()` of the installed `@oh-my-pi/pi-coding-agent`), so a subpath that only matches a `./*` export fails. Any other `@oh-my-pi` package must be declared in `package.json`, and the file its own `exports` resolve to must exist. Each named value must be a value export of the module the import runs (the legacy shim for a package root), and each `import type` name an export of the module TypeScript resolves. The same path checks on non-production files are listed apart and do not fail the gate.
- **Gates by shape:** a plugin's `omp.extensions` entries exist and default-export a function; in a `plugin-multi` or `config-bundle`, no extension imports another extension's directory (shared code goes through `_shared/` or `omomp-shared/`); every gated repository has at least one test file; a chained cast (`x as unknown as T`) in production code carries `// SAFETY: <reason>` on its line or the line above.
- **Output:** the shape, the installed `@oh-my-pi/*` versions, skipped gates with their reason and each failure by stage (`upstream-exports`, `ast-gates`); `--summary <file>` also writes them as JSON. The exit code is 1 when anything fails.

## release.ts

`release.ts` is the daily release every omomp member runs. Each member's own `.github/workflows/omomp-release.yml` checks this repository out from `main` beside the member and runs it at the member's root. One run first restores the changelog's published sections against their tags (see [Run results](#run-results)). It then promotes the member's `## [Unreleased]` changelog section to a version and bumps every version file. It commits `chore: release X.Y.Z` on `main`. It moves `main`, the tag `vX.Y.Z` and the `release` branch in one atomic push, then creates the GitHub Release `vX.Y.Z` from that section.

### Run results

A run ends in exactly one result:

- **`released`:** the run published a new version as described above.
- **`nothing-to-release`:** after the published-section check below, `## [Unreleased]` has no top-level list item, so the run pushes nothing.
- **`failed`:** the run exits non-zero, pushes no ref, and the log names the reason.

#### Published sections

The tag decides what is published, not a section's position in the file. A merge that crosses a release can drop a pull request's `## [Unreleased]` items into the section the release just wrote. Before backfilling or computing a version, the run compares every `## [X.Y.Z]` section that has a tag `vX.Y.Z` on the remote with the same section of the same changelog path in the tag's commit. A section without a tag, or one the tag's commit does not have (a missing file or section), is skipped and kept as is.

- **Only extra top-level list items:** the section is restored to the tag's text. Each extra item moves to the same `###` category of `## [Unreleased]`, which is created at the end when it is missing. The items then count in this release's version bump and notes.
- **Any other difference:** a tag line changed or removed, an extra line that is not a top-level list item (including a new `###` heading or a continuation line), or a changed heading. The run fails with `failed:`, naming the `## [X.Y.Z]` section, the tag `vX.Y.Z` and the differing lines.

### Missing Releases

After the published-section check and before deciding, a run checks the current version `V` of `<package-dir>/package.json`. If the tag `vV` is on the remote but has no GitHub Release, the run backfills the Release from the restored changelog's `## [V]` section. The backfill pushes nothing.

### Version bump

The new version follows the `###` categories that hold top-level items:

- **`### Breaking Changes`:** a major bump at 1.0 and above, a minor bump in 0.x.
- **`### Added`:** a minor bump.
- **Anything else:** a patch bump. Items above any `###` and categories outside the seven standard ones are promoted unchanged.

The section date is the GMT+9 date of the run.

### Member workflow

Each member's `.github/workflows/omomp-release.yml` is a complete job of its own:

```yaml
name: omomp-release

on:
  schedule:
    - cron: "0 17 * * *" # 02:00 GMT+9
  workflow_dispatch:

concurrency:
  group: omomp-release
  cancel-in-progress: false

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@main
        with:
          ref: main
          fetch-depth: 0
          path: repository
      - uses: actions/checkout@main
        with:
          repository: oh-my-omp/shared
          ref: main
          path: omomp-shared
          persist-credentials: false
      - uses: oven-sh/setup-bun@main
        with:
          bun-version: latest
      - name: Release
        working-directory: repository
        env:
          GH_TOKEN: ${{ github.token }}
        run: bun ../omomp-shared/release.ts --github-release "$GITHUB_REPOSITORY"
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `--package-dir` | `.` | Package root: the directory holding `package.json`, relative to the repository root. Its `package.json` must carry the member declaration `"omomp": {"changelog": "CHANGELOG.md"}`. |
| `--version-files` | empty | Further files that carry the version, relative to the repository root and separated by whitespace. In a `.json` file the version is the top-level `version`. A file named `package-lock.json` also carries `packages[""].version`. In a `.toml` file the version is the top-level `version = "X.Y.Z"` line. Any other extension fails the run. Only the version values change. |
| `--changelog` | empty | Changelog path relative to the repository root. When empty, the run uses `omomp.changelog` from the declaration, resolved against `--package-dir`. When set, the run reads and writes this file instead, but the declaration must still exist. |
| `--remote` | `origin` | The remote the run reads tags from and pushes to. |
| `--github-release` | none | `<owner>/<repo>` whose GitHub Release the run creates or backfills. Without it the run creates no Release. |

### Running it locally

The same logic runs against any git checkout whose `HEAD` is the remote `main`. Run it at the checkout root:

```sh
git clone https://github.com/oh-my-omp/shared /tmp/omomp-shared
RELEASE="bun /tmp/omomp-shared/release.ts"
$RELEASE                                   # package-dir ".", declared changelog
$RELEASE --package-dir agent/extensions/_shared --changelog CHANGELOG.md
$RELEASE --version-files "package-lock.json tern/plugin.toml"
```

The last line of the output is the result: `omomp-release: released X.Y.Z`, `omomp-release: nothing-to-release`, or `omomp-release: failed: <reason>`.

## Checks

Each repository's own `.github/workflows/omomp-check.yml` runs on pushes to `main`, on pull requests and once a day. It checks this repository out from `main` and runs `bun deps.ts check <root>`; repositories on bun then run `bun install --frozen-lockfile`, `bun update` of the packages `bun deps.ts host <root>` lists, `bun run check` and `bun run test`; every repository ends with `bun verify.ts <root>`, which compares each file declared in `omomp-shared.json` with the same file under `src/` byte for byte. A fork that keeps its upstream's package manager and CI (omp-actual-terminal) runs only `deps.ts check` and `verify.ts`.
