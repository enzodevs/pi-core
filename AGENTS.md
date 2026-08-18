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
- `make help` — list available targets

Keep implementation details in `package.json` scripts; Make targets should remain thin delegates so CI, agents, and contributors share one interface.

## Conventions

- Runtime code must work in Node; do not use Bun-only APIs.
- Use TypeBox for Pi tool schemas.
- Keep core behavior in testable modules separate from Pi event wiring and TUI code.
- Store user state beneath `~/.pi/agent/pi-core/` and write it atomically.
- Do not mutate skill files.
- Follow `CONTEXT-HYGIENE.md` for every model-facing schema, prompt, and result.
- Keep always-active tool surfaces minimal; bound variable output and return conclusions instead of transcripts.
