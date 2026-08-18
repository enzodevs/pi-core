# pi-core

Node-first TypeScript package for personal Pi extensions.

## Commands

- `npm run format` — format and lint with Biome
- `npm run typecheck` — strict TypeScript check
- `npm test` — run Vitest
- `npm run check` — run all verification

## Conventions

- Runtime code must work in Node; do not use Bun-only APIs.
- Use TypeBox for Pi tool schemas.
- Keep core behavior in testable modules separate from Pi event wiring and TUI code.
- Store user state beneath `~/.pi/agent/pi-core/` and write it atomically.
- Do not mutate skill files.
- Follow `CONTEXT-HYGIENE.md` for every model-facing schema, prompt, and result.
- Keep always-active tool surfaces minimal; bound variable output and return conclusions instead of transcripts.
