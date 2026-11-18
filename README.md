# shared

Single source of the code that several oh-my-omp repositories copy: each consumer declares the files it uses in `omomp-shared.json`, a push sync opens PRs with the copies, and each repository's check compares them byte for byte.
