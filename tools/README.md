# Tools Registry — X Ripper
Purpose: registry of this project's `tools/` scripts; read before scripting a repeated operation.
Scope: every executable in `tools/`; one row per tool — name, what it does, example invocation.
Entry points: `tools/` — the scripts; each supports `--help` for full usage.
Related: `AGENTS.md` (agent rules)
Last-verified: 2026-08-10 — verified against current main
Status: current

## How to use

Before re-deriving a multi-step command, scan the table for an existing tool and run it with `--help`. When you build a new tool, add its row here in the same change and re-stamp `Last-verified`. One executable per job lives in `tools/`.

## Tools

| Tool | What it does | Example |
|---|---|---|
| `tools/smoke-test` | Rips the canonical live X fixtures in `tools/scenarios.json` (threads, article, single post) and asserts extraction still works; run by the pre-commit hook. `XR_AUTH_STATE=~/.agent-browser/x-auth.json` runs it against the real logged-in DOM (on demand only) | `tools/smoke-test thread-long` |

## Internals

- `tools/scenarios.json` — fixture registry: one scenario per artifact kind, each a canonical URL previously ripped for real, with assertion thresholds.
- `tools/browser/` — page-side harness scripts (`shim.js`, `decorate.js`, `fire.js`, `sweep-test.js`) and the `assert.js` scenario helper. Not standalone tools; driven by `tools/smoke-test`.
- `tools/githooks/pre-commit` — runs `tools/smoke-test` on every commit; bypass with `SKIP_SMOKE=1`. Wired via `git config core.hooksPath tools/githooks`.
