# pi-core

Node-first TypeScript package for personal Pi extensions.

## Commands

Use the repository `Makefile` as the stable command interface:

- `make install` — install locked development dependencies
- `make format` — format and lint with Biome
- `make typecheck` — strict TypeScript check
- `make test` — run Vitest
- `make fallow` — gate on dead-code findings
- `make health` — report advisory Fallow health findings
- `make check` — run all required verification
- `make pack` — verify checks and published package contents
- `make compat-package` — install the packed package and load every extension through Pi
- `make compat-latest` — test a temporary copy against the latest published Pi packages
- `make help` — list available targets

Keep implementation details in `package.json` scripts; Make targets should remain thin delegates so CI, agents, and contributors share one interface.

## Pi harness upgrades

When the user reports that Pi was updated, asks about a new Pi release, or requests adapting pi-core to it, follow `PI-UPGRADES.md`. Use that on-demand workflow rather than adding a skill or duplicating upgrade instructions in the always-active prompt.

## Conventions

- Runtime code must work in Node; do not use Bun-only APIs.
- Use TypeBox for Pi tool schemas.
- Keep core behavior in testable modules separate from Pi event wiring and TUI code.
- Store user state beneath `~/.pi/agent/pi-core/` and write it atomically.
- Do not mutate skill files.
- Follow `CONTEXT-HYGIENE.md` for every model-facing schema, prompt, and result.
- Keep always-active tool surfaces minimal; bound variable output and return conclusions instead of transcripts.
- Read the installed `@earendil-works/pi-coding-agent` docs and types first when working on Pi behavior; they match the runtime under test.
- A read-only opensrc snapshot of Pi upstream is available at `/home/rrghost/.opensrc/repos/github.com/earendil-works/pi/main` for source-level API verification. Never modify it, and verify its `packages/coding-agent/package.json` version before treating it as version-matched—the snapshot may lag upstream or the installed package and may not include Git metadata.
