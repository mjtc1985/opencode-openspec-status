// `gentle-ai sdd-status --json` (gentle-ai.sdd-status@2) → `SddState`. Without
// gentle-ai the same JSON shape is inferred from the OpenSpec files
// (`openspec-files.ts`), so everything downstream is shared.
// Beware: `dependencies` marks the phase that is up next as `blocked`; it is not
// used for blockers.

import { join } from "node:path"
import type {
  BranchMatch,
  DownstreamArtifact,
  PhaseStatus,
  SddChange,
  SddPhaseId,
  SddState,
  StaleWarning,
  UpstreamArtifact,
} from "../model.ts"
import { listOf, t } from "../i18n.ts"
import { SDD_PHASES } from "../model.ts"
import { type Pin, activePin, chooseChange, isNewPin, matchBranch, readCandidates } from "./choice.ts"
import { CommandNotFoundError, parseJson, type Fsx, isInside, isObj, isValidChangeName, MAX_MARKDOWN_BYTES, newestMtime, nodeFs, type Run, sddStatusArgs } from "./exec.ts"
import { MAX_ITEMS, splitLines } from "./markdown.ts"
import { stampedChanges, statusFromFiles } from "./openspec-files.ts"
import { readGitInfo } from "./sdd-detail.ts"

export const SDD_SCHEMA = "gentle-ai.sdd-status"
export const SDD_SCHEMA_VERSION = 2

const ARTIFACTS = ["proposal", "specs", "design", "tasks", "applyProgress", "verifyReport"] as const
type ArtifactKey = (typeof ARTIFACTS)[number]

const UPSTREAM: UpstreamArtifact[] = ["proposal", "specs", "design"]
const DOWNSTREAM: DownstreamArtifact[] = ["tasks", "applyProgress", "verifyReport"]

/**
 * Margin so a single pass is not reported: the agent saves proposal, specs, tasks
 * and design one after another (design 17 s after tasks, with tasks already up to
 * date, in a real run). A real drift («I changed the spec and did not regenerate
 * the tasks») usually comes much later.
 */
export const STALE_TOLERANCE_MS = 5 * 60_000

const NEXT_PHASE: Record<string, SddPhaseId> = {
  propose: "propose",
  spec: "spec",
  design: "design",
  tasks: "tasks",
  apply: "apply",
  verify: "verify",
  archive: "archive",
}

const ARTIFACT_LABEL: Record<UpstreamArtifact, string> = { proposal: "proposal", specs: "spec", design: "design" }

type Parsed = {
  changeName: string | null
  store: string
  changeRoot: string | null
  paths: Record<ArtifactKey, string[]>
  done: Record<ArtifactKey, boolean>
  total: number
  completed: number
  pending: number
  allComplete: boolean
  applyState: string
  nextRecommended: string
  blockedReasons: string[]
  notes: string[]
}

export type SddFiles = { mtimes: Record<string, number>; tasksMd?: string }

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string")
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** Validates the shape; returns readable reasons when something is missing. */
function readShape(j: Record<string, unknown>): Parsed | string[] {
  const reasons: string[] = []
  const changeName = j.changeName
  if (changeName !== null && typeof changeName !== "string") reasons.push(t("sdd.badChangeName"))
  if (typeof j.artifactStore !== "string") reasons.push(t("sdd.missingField", { field: "artifactStore" }))
  const changeRoot = typeof j.changeRoot === "string" ? j.changeRoot : null

  const ap = j.artifactPaths
  const ar = j.artifacts
  const paths = {} as Record<ArtifactKey, string[]>
  const done = {} as Record<ArtifactKey, boolean>
  if (!isObj(ap)) reasons.push(t("sdd.missingField", { field: "artifactPaths" }))
  if (!isObj(ar)) reasons.push(t("sdd.missingField", { field: "artifacts" }))
  for (const k of ARTIFACTS) {
    if (isObj(ap)) {
      if (isStrArr(ap[k])) paths[k] = ap[k]
      else reasons.push(t("sdd.notPathList", { field: `artifactPaths.${k}` }))
    }
    if (isObj(ar)) {
      if (ar[k] === "done" || ar[k] === "missing") done[k] = ar[k] === "done"
      else reasons.push(t("sdd.notDoneMissing", { field: `artifacts.${k}` }))
    }
  }

  const tp = j.taskProgress
  if (!isObj(tp) || !isNum(tp.total) || !isNum(tp.completed) || !isNum(tp.pending)) reasons.push(t("sdd.incompleteTaskProgress"))
  if (typeof j.applyState !== "string") reasons.push(t("sdd.missingField", { field: "applyState" }))
  if (typeof j.nextRecommended !== "string") reasons.push(t("sdd.missingField", { field: "nextRecommended" }))
  if (j.blockedReasons !== undefined && !isStrArr(j.blockedReasons)) reasons.push(t("sdd.notTextList", { field: "blockedReasons" }))
  if (j.notes !== undefined && !isStrArr(j.notes)) reasons.push(t("sdd.notTextList", { field: "notes" }))
  if (reasons.length) return reasons

  const progress = tp as Record<string, number>
  return {
    changeName: changeName as string | null,
    store: j.artifactStore as string,
    changeRoot,
    paths,
    done,
    total: progress.total!,
    completed: progress.completed!,
    pending: progress.pending!,
    allComplete: (tp as Record<string, unknown>).allComplete === true,
    applyState: j.applyState as string,
    nextRecommended: j.nextRecommended as string,
    blockedReasons: (j.blockedReasons as string[] | undefined) ?? [],
    notes: (j.notes as string[] | undefined) ?? [],
  }
}

/** Contradictions between fields (gentle-ai#4702, gentle-shell#1072): nothing is invented. */
function coherence(p: Parsed): string[] {
  const reasons: string[] = []
  const openspec = p.store === "openspec"
  for (const k of ARTIFACTS) {
    if (openspec && p.done[k] && p.paths[k].length === 0) reasons.push(t("sdd.doneWithoutFiles", { artifact: k }))
  }
  if (!openspec && ARTIFACTS.some((k) => p.paths[k].length > 0)) reasons.push(t("sdd.storeWithPaths", { store: p.store }))
  if (p.total < 0 || p.completed < 0 || p.pending < 0) reasons.push(t("sdd.negativeProgress"))
  if (p.completed > p.total) reasons.push(t("sdd.moreCompleted", { completed: p.completed, total: p.total }))
  if (p.changeName === null && ARTIFACTS.some((k) => p.done[k])) reasons.push(t("sdd.noChangeButDone"))
  return reasons
}

/** First unchecked task in tasks.md, on one line. */
export function firstOpenTask(md: string | undefined): string | undefined {
  if (!md) return undefined
  for (const line of splitLines(md)) {
    // `(.*)` plus a separate `trim`: `\s+(.*\S)\s*$` is quadratic on long runs of spaces.
    const m = /^\s*[-*+]\s+\[ \][ \t](.*)$/.exec(line)
    const text = m ? m[1]!.trim() : ""
    if (text) return text.replace(/\s+/g, " ")
  }
  return undefined
}

function newest(files: string[], mtimes: Record<string, number>): { file: string; mtime: number } | undefined {
  let best: { file: string; mtime: number } | undefined
  for (const f of files) {
    const m = mtimes[f]
    if (isNum(m) && (!best || m > best.mtime)) best = { file: f, mtime: m }
  }
  return best
}

function staleness(p: Parsed, mtimes: Record<string, number>): StaleWarning[] | "unavailable" {
  if (p.store !== "openspec") return "unavailable"
  const out: StaleWarning[] = []
  for (const down of DOWNSTREAM) {
    const d = newest(p.paths[down], mtimes)
    if (!d) continue
    for (const up of UPSTREAM) {
      const u = newest(p.paths[up], mtimes)
      if (u && u.mtime > d.mtime + STALE_TOLERANCE_MS) {
        out.push({ upstream: up, downstream: down, upstreamFile: u.file, upstreamMtime: u.mtime, downstreamFile: d.file, downstreamMtime: d.mtime })
      }
    }
  }
  return out
}

/** Artifact of each phase, for `phaseUpdatedAt`. */
const PHASE_ARTIFACT: Partial<Record<SddPhaseId, ArtifactKey>> = {
  propose: "proposal",
  spec: "specs",
  design: "design",
  tasks: "tasks",
  apply: "applyProgress",
  verify: "verifyReport",
}

/**
 * Last modification of each phase's artifact. Checking tasks touches tasks.md: once
 * some are checked, that date also counts for apply.
 */
function phaseTimes(p: Parsed, mtimes: Record<string, number>): Partial<Record<SddPhaseId, number>> {
  const out: Partial<Record<SddPhaseId, number>> = {}
  for (const phase of SDD_PHASES) {
    const artifact = PHASE_ARTIFACT[phase]
    const n = artifact ? newest(p.paths[artifact], mtimes) : undefined
    if (n) out[phase] = n.mtime
  }
  const tasks = newest(p.paths.tasks, mtimes)
  if (tasks && p.completed > 0 && (out.apply === undefined || tasks.mtime > out.apply)) out.apply = tasks.mtime
  return out
}

export function parseSddStatus(json: unknown, files: SddFiles, choice?: SddChange["choice"]): SddState {
  if (!isObj(json)) return { kind: "incoherent", reasons: [t("sdd.notJsonObject")] }
  if (json.schemaName !== SDD_SCHEMA || json.schemaVersion !== SDD_SCHEMA_VERSION) {
    return { kind: "unsupported", schema: `${String(json.schemaName)}@${String(json.schemaVersion)}` }
  }
  const shape = readShape(json)
  if (Array.isArray(shape)) return { kind: "incoherent", reasons: shape }
  const p = shape
  const incoherent = coherence(p)
  if (incoherent.length) return { kind: "incoherent", reasons: incoherent }
  // No active change, or the requested one does not exist («Active OpenSpec change
  // not found»): no root and nothing done. An Engram-only change may have no root.
  if (p.changeName === null) return { kind: "none", hint: p.nextRecommended }
  if (p.changeRoot === null && !ARTIFACTS.some((k) => p.done[k])) return { kind: "none", hint: p.nextRecommended }

  const d = p.done
  const phases = {} as Record<SddPhaseId, PhaseStatus>
  phases.explore = ARTIFACTS.some((k) => d[k]) ? "done" : "todo"
  phases.propose = d.proposal ? "done" : "todo"
  phases.spec = d.specs ? "done" : "todo"
  phases.design = d.design ? "done" : "todo"
  phases.tasks = d.tasks ? "done" : "todo"
  if (p.total > 0 && p.allComplete) phases.apply = "done"
  else if (p.applyState === "blocked" && p.completed > 0) phases.apply = "blocked"
  else if (p.completed > 0 && p.completed < p.total) phases.apply = "active"
  else phases.apply = "todo"
  phases.verify = d.verifyReport ? "done" : "todo"
  phases.archive = "todo"

  let current: SddPhaseId = "explore"
  if (phases.apply === "active" || phases.apply === "blocked") current = "apply"
  else for (const ph of SDD_PHASES) if (ph !== "archive" && phases[ph] === "done") current = ph

  const blocked = p.blockedReasons.filter((r) => !/^Run `gentle-ai sdd-status/.test(r))
  if (phases.apply === "blocked") {
    const missing = UPSTREAM.filter((k) => !d[k]).map((k) => ARTIFACT_LABEL[k])
    blocked.push(missing.length ? t(missing.length > 1 ? "sdd.applyBlockedMissingMany" : "sdd.applyBlockedMissingOne", { missing: listOf(missing) }) : t("sdd.applyBlocked"))
  }

  const change: SddChange = {
    kind: "change",
    name: p.changeName,
    store: p.store,
    phases,
    current,
    nextRecommended: p.nextRecommended,
    tasks: { total: p.total, completed: p.completed, pending: p.pending },
    blocked,
    stale: staleness(p, files.mtimes),
    notes: p.notes,
  }
  const times = phaseTimes(p, files.mtimes)
  if (Object.keys(times).length > 0) change.phaseUpdatedAt = times
  const next = NEXT_PHASE[p.nextRecommended]
  if (next) change.next = next
  const task = firstOpenTask(files.tasksMd)
  if (task) change.currentTask = task
  if (choice) change.choice = choice
  return change
}

// ── Loader ──────────────────────────────────────────────────────────────────

export { stampedChanges }

/** The names from `stampedChanges`, in the same order. */
export async function activeChanges(root: string, fsx: Fsx = nodeFs): Promise<string[]> {
  return (await stampedChanges(root, fsx)).map((s) => s.name)
}

/**
 * mtimes of the artifacts named by the `sdd-status` JSON, plus tasks.md. Only paths
 * that, once resolved (links included), stay inside `root`.
 */
export async function readSddFiles(json: unknown, root: string, fsx: Fsx = nodeFs): Promise<SddFiles> {
  const mtimes: Record<string, number> = {}
  let tasksMd: string | undefined
  if (!isObj(json) || !isObj(json.artifactPaths)) return { mtimes }
  const ap = json.artifactPaths
  const all = ARTIFACTS.flatMap((k) => (isStrArr(ap[k]) ? ap[k].slice(0, MAX_ITEMS) : []))
  const inside = new Set<string>()
  await Promise.all(
    all.map(async (f) => {
      if (!(await isInside(root, f))) return
      inside.add(f)
      const m = await fsx.mtime(f)
      if (m !== undefined) mtimes[f] = m
    }),
  )
  const tasks = isStrArr(ap.tasks) ? ap.tasks[0] : undefined
  if (tasks && inside.has(tasks)) tasksMd = await fsx.readText(tasks, { maxBytes: MAX_MARKDOWN_BYTES })
  return tasksMd === undefined ? { mtimes } : { mtimes, tasksMd }
}

export type SddLoadOptions = {
  /** What was pinned in `/openspec-status` (from OpenCode's KV), if anything. */
  pin?: () => Pin | undefined
  /** `stampedChanges` already read in this poll (to detect new changes): not read again. */
  changes?: readonly { name: string; mtime: number }[]
}

/** The most recent of the dates; `undefined` if none is valid. */
function latest(values: Iterable<number | undefined>): number | undefined {
  let best: number | undefined
  for (const v of values) if (isNum(v) && v > 0 && (best === undefined || v > best)) best = v
  return best
}

/**
 * The `sdd-status` JSON for `change` (or the default selection): from gentle-ai
 * when it is installed, otherwise inferred from the OpenSpec files with the same
 * shape. Only throws if gentle-ai is installed and fails.
 */
export async function sddStatusJson(root: string, run: Run, fsx: Fsx = nodeFs, change?: string): Promise<{ json: unknown; source: "gentle-ai" | "files" }> {
  try {
    return { json: parseJson(await run("gentle-ai", sddStatusArgs(root, change), { cwd: root })), source: "gentle-ai" }
  } catch (err) {
    if (!(err instanceof CommandNotFoundError)) throw err
    return { json: await statusFromFiles(root, change, fsx), source: "files" }
  }
}

/**
 * Only throws if `run` throws (the runtime marks the source as stale). With
 * several active changes it picks one with `chooseChange` (pinned, branch,
 * recent). If the resulting change is the one pinned for this branch it carries
 * `pinned` (the sidebar focuses on it), also when it is the only one, and
 * `pinnedNew` if the plugin pinned it because it was started in the session. If it
 * is the branch's (chosen by it or, being the only one, because it matches it) it
 * carries `branchMatch`; plus `updatedAt`, the most recent of its artifacts and
 * folder (dates already read). With that the sidebar picks a methodology when
 * nothing is pinned.
 */
export async function loadSdd(root: string, run: Run, fsx: Fsx = nodeFs, options: SddLoadOptions = {}): Promise<SddState> {
  const pin = options.pin?.()
  let { json, source } = await sddStatusJson(root, run, fsx)
  let choice: SddChange["choice"]
  let match: BranchMatch | undefined
  let dirMtime: number | undefined
  if (isObj(json) && json.nextRecommended === "select-change") {
    const stamped = options.changes ?? (await stampedChanges(root, fsx))
    const names = stamped.map((s) => s.name)
    if (names.length > 0) {
      const git = await readGitInfo(root, fsx)
      const candidates = await readCandidates(root, names, fsx, git.remote)
      const { index, reason } = chooseChange(candidates, git, pin)
      const name = names[index] ?? names[0]!
      ;({ json, source } = await sddStatusJson(root, run, fsx, name))
      choice = { index: 1, total: names.length, others: names.filter((n) => n !== name), reason }
      if (reason === "branch") match = matchBranch(candidates, git)?.match
      dirMtime = stamped.find((s) => s.name === name)?.mtime
    }
  }
  if (json === undefined) return { kind: "incoherent", reasons: [t("sdd.notJson")] }
  const files = await readSddFiles(json, root, fsx)
  const state = parseSddStatus(json, files, choice)
  if (state.kind !== "change") return state
  state.source = source
  if (choice) {
    if (choice.reason === "pinned") state.pinned = true
  } else {
    // A single change: the branch tells whether it is pinned and whether it is the branch's.
    const git = await readGitInfo(root, fsx)
    if (pin?.kind === "sdd" && activePin(pin, "sdd", git.branch, [state.name]) !== undefined) state.pinned = true
    if (git.branch && isValidChangeName(state.name)) match = matchBranch(await readCandidates(root, [state.name], fsx, git.remote), git)?.match
  }
  if (state.pinned && isNewPin(pin)) state.pinnedNew = true
  if (match) state.branchMatch = match
  const updatedAt = latest([dirMtime, ...Object.values(files.mtimes)])
  if (updatedAt !== undefined) state.updatedAt = updatedAt
  return state
}
