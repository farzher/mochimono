# AGENTS.md

Mochimono is in rapid pre-user development. Optimize for quick iteration and a minimal, clean codebase.

- Use plain JavaScript. Avoid TypeScript and unnecessary build tooling.
- There are no users, production data, or compatibility requirements yet. Breaking changes are acceptable.
- Do not add migrations, version compatibility, legacy support, fallback behavior, compatibility shims, or transitional code unless explicitly requested.
- Prefer replacing or deleting an old design instead of preserving multiple approaches.
- Do not add CI, routine automated tests, test suites, test harnesses, broad verification work, or merge gates by default. They slow iteration and become stale while the product is changing quickly.
- If a concrete difficult bug truly benefits from a targeted diagnostic check, keep it temporary and narrowly scoped unless explicitly asked to retain it.
- Prefer direct implementation and quick manual/sanity checks while features and architecture are still changing.
- Serious automated testing and CI can be added later when the product shape and data model have stabilized.
- Do not over-engineer. Avoid abstractions, frameworks, dependencies, generalized subsystems, and future-proofing until current usage requires them.
- Prefer the smallest direct implementation that cleanly solves the current problem.
- Keep the repository cohesive rather than splitting components into separate projects without a concrete need.
- Keep user-facing UI and wording clean, minimal, and action-oriented. Assume the user already understands how Mochimono works; avoid explanatory, instructional, redundant, or marketing-style copy unless it prevents a mistake or communicates an exceptional state.
- Runtime integrity behavior that protects stored user data, such as content-hash verification, is part of the product and should not be removed merely to reduce development overhead.

The goal right now is to use Mochimono, learn quickly, and change the design freely as we discover what works.
