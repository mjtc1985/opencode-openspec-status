# opencode-openspec-status — contributor guide

A **read-only** OpenCode TUI plugin: it draws in the sidebar where the project
stands in its OpenSpec (SDD) or ODD flow, plus the gentle-ai review when there is
one.

## Layout

- `src/model.ts` — type contract between layers. No IO.
- `src/i18n.ts` — `en` and `es` messages, `t(key, params)` and locale detection.
  Every user-visible string goes through it; add each new key to both locales.
- `src/sources/` — pure parsers for `sdd-status`, `review status`,
  `review-state.json`, `odd/tasks/*.md` and git, plus the file readers. They
  produce a `Snapshot`. `openspec-files.ts` infers the `sdd-status` JSON from the
  OpenSpec files when gentle-ai is not installed.
- `src/view/` — `Snapshot` → `FlowView` → lines of `{ text, color, bold }`
  segments (sidebar ≤ 38 columns, full screen, compact indicator). No IO.
- `src/runtime/` — `run.ts`: the real `Run` (argv without a shell, `isAllowed`
  allowlist before every spawn, 5 s timeout, 2 MB cap, executable lookup with a
  fallback PATH); `poller.ts`: per-source polling without overlaps, last value
  plus `stale`; `activity.ts`: the open session's activity (`api.state.session`:
  status, questions and permissions) and since when it has been working.
- `src/app.tsx` — the plugin itself, independent of the OpenCode version: poller,
  pin, session activity, the route views and their keys, behind a small `Host`
  interface (route, navigation, pin storage, session state, colors, renderer).
- `src/tui.tsx` — OpenCode 1.x adapter (`@opencode-ai/plugin/tui`), loaded through
  the `./tui` export of package.json.
- `src/opencode-2.tsx` — OpenCode 2.x adapter (`@opencode/plugin/tui`), loaded
  through `tui.ts` at the root (OpenCode 2 resolves `<folder>/tui`). Only the two
  adapters depend on an OpenCode API; keep them thin and put behavior in `app.tsx`.
- `test/fixtures/` — gentle-ai 3.7.0 outputs (anonymized) and synthetic ones
  marked `synth`.

## Commands

- `bun install` — dependencies.
- `bun run check` — typecheck + tests. Run it before calling anything done.
- `bun test` — tests only. The suite runs with the Spanish locale (`test/setup.ts`);
  `test/view/english.test.ts` covers English.

## Rules

- **Read-only.** The plugin may only run `gentle-ai sdd-status`,
  `gentle-ai review status` and `git --no-optional-locks status`, and read files.
  Never `review start`, `capture-*`, `recover`, `sdd-continue` or anything that
  changes state, even if a JSON carries the command ready to run. The only write
  is the pin (SDD change or ODD feature), set with Enter in `/openspec-status` or
  by the plugin when new work starts in the session (`origin: "new"`,
  `src/runtime/new-work.ts`), in OpenCode's KV (`api.kv`, key
  `openspec-status:pin:<real root>:<session>`, one per session); never in
  gentle-ai or the project.
- `gentle-ai review status` runs `git init` if the folder is not a repo: only
  call it when `<root>/.git` exists.
- gentle-ai is optional: a missing executable raises `CommandNotFoundError`; SDD
  falls back to the files and the review is hidden. Any other failure marks the
  source stale.
- No emoji in the UI (they take two columns): use thin box drawing ┌─┐ and
  ●◉○✓✗▸▼◀. Text coming from outside may carry them (✅ ⏳, CJK): always measure
  with `displayWidth` from `src/view/text.ts`, never `.length`.
- In opentui `<span>` has no typed `fg`: each segment is a `<text>` inside a
  `<box flexDirection="row">`.
- The TUI plugin APIs are not in the public docs: read
  `node_modules/@opencode-ai/plugin/dist/tui.d.ts` (1.18.33) and
  `node_modules/@opencode/plugin/dist/tui/context.d.ts` (2.1.1). In 2.x,
  `ui.router.current()` is a live store: copy it before keeping it.
- To try OpenCode 2 without replacing a 1.x install, run its binary from another
  folder with `--standalone` (otherwise it starts a background service) and with
  `XDG_*` pointing to a scratch folder.
- Repository files can be hostile. Read them only with `fsx.readText(path,
  { maxBytes })` and the caps in `exec.ts` (regular files only, never blocking on
  a FIFO); never a direct `readFile`.
- Linear parsers: no regexes with overlapping quantifiers (`\s+(.*?)\s*$`,
  `[...]+$`, `Math.min(...list)`); split with `splitLines` and use the caps in
  `src/sources/markdown.ts` (2 KB line, items, text). See `hostile.test.ts`.
- Children are spawned with `childEnv`: PATH with absolute entries only and
  `core.fsmonitor=false`; in their own process group so the timeout kills
  grandchildren too.
- Containment with real paths (`isInside` in `exec.ts`, resolves links and
  /tmp → /private/tmp), never only lexical, before reading paths gentle-ai gives.
- The parsers also recognize Spanish headings and marks (`Tareas`,
  `Siguiente paso`, `(parcial)`…): keep both languages when touching them.
- Bun sometimes creates `bun.lockb` with mode 0777: keep it at 644.
- English in docs, comments and commits (Conventional Commits).
