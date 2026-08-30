# AGENTS.md

Mochimono is in rapid pre-user development. Optimize for quick iteration and a minimal, clean codebase.

- Use plain JavaScript. Avoid TypeScript and unnecessary build tooling.
- There are no users or compatibility requirements yet. Breaking changes are acceptable.
- Do not add migrations, version compatibility, legacy support, fallback behavior, compatibility shims, or transitional code unless explicitly requested.
- Prefer replacing or deleting an old design instead of preserving multiple approaches.
- Do not add tests, test harnesses, or broad verification work unless explicitly requested or needed to diagnose a concrete bug.
- Do not over-engineer. Avoid abstractions, frameworks, dependencies, generalized subsystems, and future-proofing until current usage requires them.
- Prefer the smallest direct implementation that cleanly solves the current problem.
- Keep the repository cohesive rather than splitting components into separate projects without a concrete need.
- Keep user-facing UI and wording clean, minimal, and action-oriented. Assume the user already understands how Mochimono works; avoid explanatory, instructional, redundant, or marketing-style copy unless it prevents a mistake or communicates an exceptional state.
- Runtime integrity behavior that protects stored user data, such as content-hash verification, is part of the product and should not be removed merely to reduce development overhead.

The goal right now is to use Mochimono, learn quickly, and change the design freely as we discover what works.
