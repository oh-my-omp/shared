# shared

Single source of the code that several oh-my-omp repositories copy: each consumer declares the files it uses in `omomp-shared.json`, a push sync opens PRs with the copies, and each repository's check compares them byte for byte.

`deps.ts` is the dependency check every repository's check runs: `bun deps.ts check <root>` fails on a pinned dependency, a non-`*` peer, a legacy pi or typebox package, a tracked `declare module "@oh-my-pi/…"`, or production TypeScript that hands a tool definition to the host without the shared entry (a `registerTool(…)` argument or a `customTools` element that is not a direct `omompTool(…)` call, see [tool-entry.ts](#tool-entryts); `*.test.{ts,tsx,mts,cts}`, `*.spec.{ts,tsx}`, `*.d.ts` and files under a `test/`, `tests/`, `__tests__/` or `node_modules/` directory are not production); `bun deps.ts host <root>` lists the `@oh-my-pi` packages the check upgrades to their newest release before type-checking.

## tool-entry.ts

`tool-entry.ts` is the registration entry every omomp plugin tool goes through: wrap the tool definition in `omompTool` before handing it to the host, both for `pi.registerTool(omompTool(definition))` and for every element of a new session's `customTools`. The wrapped definition is the same object shape; the plugin's `execute` no longer deals with empty values or undeclared keys.

A string field whose value must reach the tool exactly as the model wrote it — terminal input, find-and-replace text — is declared verbatim by wrapping its complete field schema: `chars: verbatim(z.string().optional().describe("…"))` for the zod-like facade, `verbatim(Type.Optional(Type.String({ description: "…" })))` for TypeBox. The declaration changes nothing the model is sent.

The model-visible behaviour:

- **Empty means not passed.** By the declared field type: a string field whose value trims to nothing, `[]` on an array field, `{}` on an object field, and `null` on any field are all the same as omitting the field. A required field given an empty value is refused exactly as if the field were missing. `0`, `false`, enum members, and the text `"[]"`/`"{}"` written on a string field are real values, never empty. Fields nested inside objects behave the same way; an object whose fields all drop out this way counts as empty itself.
- **Verbatim string fields:** only `""` counts as not passed; whitespace-only values reach the tool unchanged.
- **Empty array elements are a refusal.** An array element that is empty by its declared type — including an object element whose fields all drop out — refuses the whole call; the refusal names the field path and the element index. Elements are never silently dropped.
- **Everything else is the host's validation.** Type errors, values outside an enum, and missing required fields are refused with the host's `Validation failed for tool` text; the host's repairs (stringified arrays, double-encoded keys, flattened array paths, enum whitespace, a single value wrapped in an array) apply before the tool runs. Keys the parameters do not declare never reach `execute`.

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
