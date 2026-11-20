# shared

Single source of the code that several oh-my-omp repositories copy: each consumer declares the files it uses in `omomp-shared.json`, a push sync opens PRs with the copies, and each repository's check compares them byte for byte.

`deps.ts` is the dependency check every repository's check runs: `bun deps.ts check <root>` fails on a pinned dependency, a non-`*` peer, a legacy pi or typebox package, or a tracked `declare module "@oh-my-pi/…"`; `bun deps.ts host <root>` lists the `@oh-my-pi` packages the check upgrades to their newest release before type-checking.
