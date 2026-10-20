// SDD status without gentle-ai: the same JSON shape as `gentle-ai sdd-status
// --json` (gentle-ai.sdd-status@2), inferred from the OpenSpec files. Phases come
// from which artifacts exist, task progress from the tasks.md checkboxes, and the
// next step from the first missing artifact. Read-only, bounded reads, never
// throws.

import { join } from "node:path"
import { t } from "../i18n.ts"
import { type Fsx, isInside, isValidChangeName, MAX_MARKDOWN_BYTES, newestMtime, nodeFs } from "./exec.ts"
import { FENCE, MAX_ITEMS, splitLines } from "./markdown.ts"

const SCHEMA = { schemaName: "gentle-ai.sdd-status", schemaVersion: 2 } as const
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]/

/**
 * Active changes in `openspec/changes` with the last modification of their
 * contents, newest first. Without names `sdd-status` would not accept.
 */
export async function stampedChanges(root: string, fsx: Fsx = nodeFs): Promise<{ name: string; mtime: number }[]> {
  const base = join(root, "openspec", "changes")
  const dirs = (await fsx.listDir(base))
    .filter((e) => e.dir && e.name !== "archive" && isValidChangeName(e.name))
    .slice(0, MAX_ITEMS)
    .map((e) => e.name)
  const stamped = await Promise.all(dirs.map(async (name) => ({ name, mtime: await newestMtime(fsx, join(base, name)) })))
  return stamped.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
}

/** Checked and unchecked boxes in tasks.md, outside code blocks. */
export function countTasks(md: string | undefined): { total: number; completed: number } {
  let total = 0
  let completed = 0
  let fenced = false
  for (const line of splitLines(md ?? "")) {
    if (FENCE.test(line)) fenced = !fenced
    if (fenced) continue
    const m = CHECKBOX.exec(line)
    if (!m) continue
    total++
    if (m[1] !== " ") completed++
  }
  return { total, completed }
}

const EMPTY_PATHS = { proposal: [], specs: [], design: [], tasks: [], applyProgress: [], verifyReport: [] }
const ALL_MISSING = { proposal: "missing", specs: "missing", design: "missing", tasks: "missing", applyProgress: "missing", verifyReport: "missing" }

function noChange(root: string, nextRecommended: string, blockedReasons: string[]): Record<string, unknown> {
  return {
    ...SCHEMA,
    changeName: null,
    artifactStore: "openspec",
    planningHome: { mode: "repo-local", path: join(root, "openspec") },
    changeRoot: null,
    artifactPaths: EMPTY_PATHS,
    artifacts: ALL_MISSING,
    taskProgress: { total: 0, completed: 0, pending: 0, allComplete: false },
    applyState: "blocked",
    nextRecommended,
    blockedReasons,
    notes: [t("sdd.inferredNote")],
  }
}

/** The file if it is a regular file inside `root`, as a one-element list. */
async function present(root: string, file: string, fsx: Fsx): Promise<string[]> {
  return (await fsx.exists(file)) && (await isInside(root, file)) ? [file] : []
}

/** `specs/<capability>/spec.md` files of the change, sorted by capability. */
async function specFiles(root: string, dir: string, fsx: Fsx): Promise<string[]> {
  const caps = (await fsx.listDir(join(dir, "specs"))).filter((e) => e.dir).slice(0, MAX_ITEMS)
  const files = await Promise.all(caps.map((c) => present(root, join(dir, "specs", c.name, "spec.md"), fsx)))
  return files.flat().sort()
}

/**
 * `sdd-status` JSON for `change`, or for the default selection when omitted: no
 * active change → `sdd-new`; several → `select-change` (the caller picks one, as
 * with gentle-ai); exactly one → that change.
 */
export async function statusFromFiles(root: string, change: string | undefined, fsx: Fsx = nodeFs): Promise<Record<string, unknown>> {
  let name = change
  if (name === undefined) {
    const names = (await stampedChanges(root, fsx)).map((s) => s.name)
    if (names.length === 0) return noChange(root, "sdd-new", [])
    if (names.length > 1) return noChange(root, "select-change", [t("sdd.ambiguous", { names: names.join(", ") })])
    name = names[0]!
  }
  const dir = join(root, "openspec", "changes", name)
  if (!isValidChangeName(name) || !(await fsx.exists(dir)) || !(await isInside(root, dir))) return { ...noChange(root, "sdd-new", []), changeName: name }

  const paths = {
    proposal: await present(root, join(dir, "proposal.md"), fsx),
    specs: await specFiles(root, dir, fsx),
    design: await present(root, join(dir, "design.md"), fsx),
    tasks: await present(root, join(dir, "tasks.md"), fsx),
    applyProgress: await present(root, join(dir, "apply-progress.md"), fsx),
    verifyReport: await present(root, join(dir, "verify-report.md"), fsx),
  }
  const done = (k: keyof typeof paths) => paths[k].length > 0
  const tasksMd = done("tasks") ? await fsx.readText(paths.tasks[0]!, { maxBytes: MAX_MARKDOWN_BYTES }) : undefined
  const { total, completed } = countTasks(tasksMd)
  const pending = total - completed
  const allComplete = total > 0 && pending === 0
  const planned = done("proposal") && done("specs") && done("design")

  let nextRecommended: string
  if (!done("proposal")) nextRecommended = "propose"
  else if (!done("specs")) nextRecommended = "spec"
  else if (!done("design")) nextRecommended = "design"
  else if (!done("tasks")) nextRecommended = "tasks"
  else if (pending > 0) nextRecommended = "apply"
  else nextRecommended = "archive"

  return {
    ...SCHEMA,
    changeName: name,
    artifactStore: "openspec",
    planningHome: { mode: "repo-local", path: join(root, "openspec") },
    changeRoot: dir,
    artifactPaths: paths,
    artifacts: Object.fromEntries(Object.keys(paths).map((k) => [k, done(k as keyof typeof paths) ? "done" : "missing"])),
    taskProgress: { total, completed, pending, allComplete },
    applyState: !done("tasks") || !planned ? "blocked" : allComplete ? "all_done" : "ready",
    nextRecommended,
    blockedReasons: [],
    notes: [t("sdd.inferredNote")],
  }
}
