// `Snapshot` → `FlowView`: what to draw, already worked out (stale sources, ODD
// cycle step, review mark, sorted drift warnings), so renderers only place text.
// No IO.
import { t } from "../i18n.ts"
import {
  SDD_PHASES,
  type DownstreamArtifact,
  type GitState,
  type OddFeature,
  type ReviewState,
  type SddChange,
  type SessionActivity,
  type SddPhaseId,
  type Snapshot,
  type StaleWarning,
  type UpstreamArtifact,
} from "../model.ts"
import { chooseFocus } from "./choose-focus.ts"

export type SourceId = "sdd" | "odd" | "review" | "git"

/** A source whose last read failed: its last known value is drawn. */
export type StaleSource = { source: SourceId; label: string; ageMs: number; error: string }

/** Review mark: ✓ approved · ◉ in progress · ✗ asks for corrections. */
export type ReviewMark = "ok" | "running" | "failed"

/** Step of the ODD per-task cycle (inferred, never read from gentle-ai). */
export type CycleStep = "code" | "checks" | "commit" | "review"

/** A drifted earlier phase → later phase pair, with its original warnings. */
export type StalePair = { upstream: SddPhaseId; downstream: SddPhaseId; warnings: StaleWarning[] }

export type SddChangeView = {
  kind: "change"
  change: SddChange
  /** Sorted by importance: earliest later phase and, within it, the most recent earlier one. */
  stalePairs: StalePair[]
  /** The apply loop is live: apply is the current phase and tasks remain. */
  applyLoopHot: boolean
  /** `next === current`: the next step is to keep going in the same phase. */
  continueCurrent: boolean
  /**
   * Phase «in progress»: the agent is working and its artifact was the last one
   * touched, less than `WRITING_WINDOW_MS` ago. The box moves to it, with ◉ and the clock.
   */
  writing?: SddPhaseId
  /** The agent is asking you, or stopped with a next phase ahead: «waiting for you». */
  awaitingOk: boolean
}

export type SddView =
  | { kind: "none"; hint?: string }
  | { kind: "incoherent"; reasons: string[] }
  | { kind: "unsupported"; schema: string }
  | SddChangeView

export type OddFeatureView = {
  kind: "feature"
  feature: OddFeature
  /** Title without the «Feature:» prefix. */
  name: string
  total: number
  done: number
  /** Unfinished tasks besides the current one. */
  pending: number
  /** Highlighted cycle step; `undefined` if it cannot be inferred. */
  step?: CycleStep
  /** The agent is working and there are uncommitted changes or the document was touched recently. */
  working: boolean
}

export type OddView = { kind: "none" } | OddFeatureView

/** Focused methodology: the sidebar and the indicator only show that one. */
export type Focus = "sdd" | "odd"
/** Why: pinned by hand, the branch's or the most recent (the last two without a pin). */
export type FocusReason = "pinned" | "branch" | "recent"

export type FlowView = {
  root: string
  now: number
  /** Neither an SDD change nor an ODD feature. */
  idle: boolean
  sdd: SddView
  odd: OddView
  review: ReviewState
  reviewMark?: ReviewMark
  git: GitState
  stale: StaleSource[]
  /** The pin for this branch or, without one, what `chooseFocus` picked; without focus everything is shown. */
  focus?: Focus
  focusReason?: FocusReason
  /** What the agent is doing in the open session; absent without a session (home screen). */
  activity?: SessionActivity
}

/** `buildView` options that do not come from the `Snapshot`. */
export type BuildOptions = { activity?: SessionActivity }

/** A phase counts as «in progress» if its artifact was touched less than this ago. */
export const WRITING_WINDOW_MS = 3 * 60_000

const SOURCE_LABELS: Record<SourceId, string> = {
  sdd: "sdd-status",
  odd: "odd/tasks",
  review: "review status",
  git: "git",
}

export const UPSTREAM_PHASE: Record<UpstreamArtifact, SddPhaseId> = { proposal: "propose", specs: "spec", design: "design" }
export const DOWNSTREAM_PHASE: Record<DownstreamArtifact, SddPhaseId> = { tasks: "tasks", applyProgress: "apply", verifyReport: "verify" }

/** Review states that no longer move on their own. */
const TERMINAL_REVIEW_STATES = new Set([
  "approved",
  "correction_required",
  "declined",
  "rejected",
  "abandoned",
  "cancelled",
  "canceled",
  "superseded",
  "closed",
  "failed",
  "expired",
  "completed",
])

export function reviewMarkOf(state: string): ReviewMark | undefined {
  if (state === "correction_required") return "failed"
  if (state === "approved") return "ok"
  if (TERMINAL_REVIEW_STATES.has(state)) return undefined
  return "running"
}

const phaseIndex = (phase: SddPhaseId) => SDD_PHASES.indexOf(phase)

/** Groups the warnings by phase pair and sorts them by importance. */
export function stalePairsOf(warnings: StaleWarning[]): StalePair[] {
  const pairs = new Map<string, StalePair>()
  for (const w of warnings) {
    const upstream = UPSTREAM_PHASE[w.upstream]
    const downstream = DOWNSTREAM_PHASE[w.downstream]
    if (!upstream || !downstream) continue
    const key = `${upstream}>${downstream}`
    const pair = pairs.get(key) ?? { upstream, downstream, warnings: [] }
    pair.warnings.push(w)
    pairs.set(key, pair)
  }
  const newest = (p: StalePair) => Math.max(...p.warnings.map((w) => w.upstreamMtime))
  return [...pairs.values()].sort(
    (a, b) => phaseIndex(a.downstream) - phaseIndex(b.downstream) || newest(b) - newest(a) || phaseIndex(b.upstream) - phaseIndex(a.upstream),
  )
}

const recent = (at: number | undefined, now: number) => at !== undefined && now - at <= WRITING_WINDOW_MS

/**
 * With the agent working, the phase whose artifact was touched last, if less than
 * `WRITING_WINDOW_MS` ago; on equal dates, the later one (checking tasks touches
 * tasks.md, which counts for both tasks and apply).
 */
export function writingPhase(change: SddChange, activity: SessionActivity | undefined, now: number): SddPhaseId | undefined {
  if (activity?.state !== "busy" || !change.phaseUpdatedAt) return undefined
  let best: { phase: SddPhaseId; at: number } | undefined
  for (const phase of SDD_PHASES) {
    const at = change.phaseUpdatedAt[phase]
    if (at !== undefined && (!best || at >= best.at)) best = { phase, at }
  }
  return best && recent(best.at, now) ? best.phase : undefined
}

function sddView(snapshot: Snapshot, now: number, activity: SessionActivity | undefined): SddView {
  const sdd = snapshot.sdd.value
  if (sdd.kind !== "change") return sdd
  const writing = writingPhase(sdd, activity, now)
  const stopped = activity?.state === "idle" && sdd.current !== "archive" && sdd.next !== undefined
  return {
    kind: "change",
    change: sdd,
    stalePairs: sdd.stale === "unavailable" ? [] : stalePairsOf(sdd.stale),
    applyLoopHot: sdd.current === "apply" && sdd.tasks.pending > 0,
    continueCurrent: sdd.next !== undefined && sdd.next === sdd.current,
    ...(writing ? { writing } : {}),
    awaitingOk: activity?.state === "waiting" || stopped,
  }
}

function cycleStep(review: ReviewState, mark: ReviewMark | undefined, git: GitState): CycleStep | undefined {
  if (review.kind === "review" && (mark === "failed" || mark === "running")) return "review"
  if (git.kind !== "repo") return undefined
  return git.dirty ? "code" : "commit"
}

function oddView(snapshot: Snapshot, mark: ReviewMark | undefined, now: number, activity: SessionActivity | undefined): OddView {
  const odd = snapshot.odd.value
  if (odd.kind !== "feature") return odd
  const done = odd.tasks.filter((task) => task.status === "done").length
  const pending = odd.tasks.filter((task) => task.status !== "done" && task.id !== odd.current?.id).length
  return {
    kind: "feature",
    feature: odd,
    name: odd.title.replace(/^\s*feature\s*:\s*/i, "").trim() || odd.file,
    total: odd.tasks.length,
    done,
    pending,
    step: cycleStep(snapshot.review.value, mark, snapshot.git.value),
    working: activity?.state === "busy" && ((snapshot.git.value.kind === "repo" && snapshot.git.value.dirty) || recent(odd.updatedAt, now)),
  }
}

function staleSources(snapshot: Snapshot, now: number): StaleSource[] {
  const out: StaleSource[] = []
  for (const source of ["sdd", "odd", "review", "git"] as const) {
    const stale = snapshot[source].stale
    if (stale) out.push({ source, label: SOURCE_LABELS[source], ageMs: Math.max(0, now - stale.since), error: stale.error })
  }
  return out
}

export function buildView(snapshot: Snapshot, now: number, options: BuildOptions = {}): FlowView {
  const { activity } = options
  const review = snapshot.review.value
  const reviewMark = review.kind === "review" ? reviewMarkOf(review.state) : undefined
  const sdd = sddView(snapshot, now, activity)
  const odd = oddView(snapshot, reviewMark, now, activity)
  const focus = chooseFocus(sdd, odd)
  return {
    root: snapshot.root,
    now,
    idle: sdd.kind === "none" && odd.kind === "none",
    sdd,
    odd,
    review,
    ...(reviewMark ? { reviewMark } : {}),
    git: snapshot.git.value,
    stale: staleSources(snapshot, now),
    ...(focus ? { focus: focus.focus, focusReason: focus.reason } : {}),
    ...(activity ? { activity } : {}),
  }
}

/** Working time: «0:05», «1:24», «12:03»; from one hour on, «1h 02m». */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
  return `${m}:${String(s % 60).padStart(2, "0")}`
}

/** Clock of the working agent; empty without `since`. */
export function workingClock(view: FlowView): string {
  const since = view.activity?.since
  return since === undefined ? "" : formatElapsed(view.now - since)
}

/** «40 s», «3 min», «2 h», «5 d». */
export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

/**
 * What the `/openspec-status` SDD detail shows about work in progress, on the row
 * of the sidebar's change: the same as the sidebar, on one line.
 */
export function detailLive(view: FlowView): { name: string; writing?: SddPhaseId; text: string; tone: "accent" | "warning" } | undefined {
  const sdd = view.sdd
  if (sdd.kind !== "change") return undefined
  const name = sdd.change.name
  if (view.activity?.state === "busy") {
    const clock = workingClock(view)
    const text = sdd.writing ? `◉ ${t("live.writing", { phase: sdd.writing })} ${clock}` : `◉ ${t("live.working")} ${clock}`
    return { name, ...(sdd.writing ? { writing: sdd.writing } : {}), text: text.trimEnd(), tone: "accent" }
  }
  if (sdd.awaitingOk) return { name, text: t("live.waiting"), tone: "warning" }
  return undefined
}
