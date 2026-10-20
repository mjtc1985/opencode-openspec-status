# Feature: sample-app-skeleton

## Objective

Working skeleton of a small CLI tool with a plugin for the editor, so the flow can
be tried end to end.

## Problem / why

Nobody can try the idea until there is something that runs.

## Scope (authorized)

- Core library, editor plugin and installer.
- Out of scope: publishing, other editors.

## Constraints

- Keep the name in few places so it can be renamed.

## Configuration

- TDD: off. Source: no project configuration. Runner: `bun test`.

## Tasks

- [x] T1 Scaffold: root commit, feature branch, package.json, tsconfig, .gitignore, AGENTS.md (commands), README stub. Route: inline (mechanical).
- [x] T2 Core: phases, state file, config file, feature parsing, transition rules + tests. Route: delegated writer (2+ non-trivial files).
- [x] T3 Server plugin: phase tool, edit guard outside the state folder, toasts + tests. Route: delegated writer.
- [x] T4 TUI plugin: sidebar phase bar with colors, task progress, target branch; compact indicator. Route: delegated writer.
- [x] T5 Content: primary agent and the start/plan/build/check commands. Route: delegated writer.
- [x] T6 Installer `sample init` (copy content, register plugins, create the config) + README usage. Route: delegated writer.
- [ ] T8 Reduce friction while exploring (allow read-only `ls`, `pwd` and git reads). Route: inline (1 content file + test). Status: waiting for the review decision.
- [ ] T9 Flow diagram in the sidebar: boxes and arrows per phase, the active phase highlighted, loops. Route: delegated writer (2 non-trivial files).
- [ ] T7 (partial) End-to-end check: sample project, init command, open the TUI, walk the four phases. Route: inline (verification).

## Acceptance criteria

- `bun test` and the typecheck pass.

## Progress / evidence

- T1: commits `2efaaf4` and `1426585`.
- T2–T6: one commit per task.

## Next step

User runs the interactive TUI check; then reduce exploration friction in the agent (new task).
