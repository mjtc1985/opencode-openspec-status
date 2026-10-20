// Contract between layers. `sources/` turns what gentle-ai, OpenSpec files, git
// and ODD documents provide into a `Snapshot`; `view/` turns it into a `FlowView`
// and renders it as lines of segments; `tui.tsx` only maps colors and draws.
// Nothing in this file does IO.

// ── SDD ─────────────────────────────────────────────────────────────────────

export const SDD_PHASES = ["explore", "propose", "spec", "design", "tasks", "apply", "verify", "archive"] as const
export type SddPhaseId = (typeof SDD_PHASES)[number]

/** `blocked`: the phase has work done but earlier phases are missing. */
export type PhaseStatus = "done" | "active" | "todo" | "blocked"

export type UpstreamArtifact = "proposal" | "specs" | "design"
export type DownstreamArtifact = "tasks" | "applyProgress" | "verifyReport"

/** An earlier artifact modified after a later one. */
export type StaleWarning = {
  upstream: UpstreamArtifact
  downstream: DownstreamArtifact
  upstreamFile: string
  upstreamMtime: number // ms epoch
  downstreamFile: string
  downstreamMtime: number
}

export type TaskProgress = { total: number; completed: number; pending: number }

/**
 * Why it matches the branch: by its work item (from `.openspec.yaml`, SDD only) or
 * because its name appears in the branch. `length`: length of that name (the
 * longest is the most specific).
 */
export type BranchMatch = { by: "workItem" | "name"; length: number }

export type SddChange = {
  kind: "change"
  name: string
  store: string // "openspec" | "engram" | …
  /** Where the status comes from: `gentle-ai sdd-status`, or inferred from the OpenSpec files. */
  source?: "gentle-ai" | "files"
  /**
   * Present when several changes were active and one was chosen. `reason`: why
   * this one (pinned by hand, the branch's, or the most recent).
   */
  choice?: { index: number; total: number; others: string[]; reason?: "pinned" | "branch" | "recent" }
  /** Pinned by hand for this branch: the sidebar focuses on SDD. */
  pinned?: boolean
  /** The plugin pinned it because the change was started in this session: «new» instead of «pinned». */
  pinnedNew?: boolean
  /** It is the branch's change (chosen by it or, if it is the only one, because it matches it). */
  branchMatch?: BranchMatch
  /** Last modification of its files (ms epoch); absent without files (e.g. Engram). */
  updatedAt?: number
  /**
   * Last modification of each phase's artifact (ms epoch): proposal → propose,
   * specs → spec, design → design, tasks.md → tasks, apply-progress (and tasks.md
   * once tasks are checked) → apply, verify-report → verify. Absent without files.
   */
  phaseUpdatedAt?: Partial<Record<SddPhaseId, number>>
  phases: Record<SddPhaseId, PhaseStatus>
  /** «You are here»: the last phase done, or `apply` while it is half done. */
  current: SddPhaseId
  /** «Next»: the phase of `nextRecommended`, when it maps to a phase. */
  next?: SddPhaseId
  /** `nextRecommended` as reported (e.g. `archive`, `sdd-new`). */
  nextRecommended: string
  tasks: TaskProgress
  /** Text of the first unchecked task in tasks.md. */
  currentTask?: string
  /** `blockedReasons` plus inferred blockers, as plain text. */
  blocked: string[]
  /** `unavailable`: the store has no files (e.g. Engram). */
  stale: StaleWarning[] | "unavailable"
  notes: string[]
}

export type SddState =
  | { kind: "none"; hint?: string }
  | { kind: "incoherent"; reasons: string[] }
  | { kind: "unsupported"; schema: string }
  | SddChange

// ── ODD ─────────────────────────────────────────────────────────────────────

export type OddTaskStatus = "done" | "active" | "todo"
export type OddTask = { id: string; title: string; status: OddTaskStatus }

export type OddFeature = {
  kind: "feature"
  file: string // relative to the project root
  title: string
  tasks: OddTask[]
  current?: OddTask
  /** «Next step» / «Siguiente paso» section, on one line. */
  nextStep?: string
  allDone: boolean
  /** What the parser did not understand; shown, never fatal. */
  warnings: string[]
  /** Pinned by hand for this branch: the sidebar focuses on ODD. */
  pinned?: boolean
  /** The plugin pinned it because the feature was started in this session: «new» instead of «pinned». */
  pinnedNew?: boolean
  /** Chosen because its name appears in the branch. */
  branchMatch?: BranchMatch
  /** Last modification of the document (ms epoch). */
  updatedAt?: number
}

export type OddState = { kind: "none" } | OddFeature

// ── Review ──────────────────────────────────────────────────────────────────

export const LENSES = ["risk", "resilience", "readability", "reliability"] as const

/** ok: no CRITICAL/WARNING findings · findings: it has some · running: no result yet. */
export type LensStatus = { lens: string; status: "ok" | "findings" | "running"; findings?: number }

export type ReviewStop = {
  kind: string // next_transition.kind: stop | collect | execute | …
  reasonCode: string
  description?: string
}

export type Review = {
  kind: "review"
  lineageId: string
  /** entries[].state: reviewing | correction_required | approved | … */
  state: string
  /** entries[].status: active | recovered | superseded | … */
  entryStatus: string
  riskLevel?: string
  /** null: review-state.json could not be read or its format is not understood. */
  lenses: LensStatus[] | null
  /** current: the review is of the current code · other: of a different code state. */
  applies: "current" | "other" | "unknown"
  /** What it asks for when stopped; only when `applies === "current"`. */
  stop?: ReviewStop
}

export type ReviewState =
  | { kind: "none" }
  | { kind: "unavailable"; reason: string } // e.g. no .git
  | { kind: "incoherent"; reasons: string[] }
  | Review

// ── Git ─────────────────────────────────────────────────────────────────────

export type GitState = { kind: "none" } | { kind: "repo"; dirty: boolean }

// ── Snapshot ────────────────────────────────────────────────────────────────

/** A source's value plus, if the last read failed, since when and why. */
export type Sourced<T> = { value: T; stale?: { since: number; error: string } }

export type Snapshot = {
  root: string
  sdd: Sourced<SddState>
  odd: Sourced<OddState>
  review: Sourced<ReviewState>
  git: Sourced<GitState>
}

// ── OpenCode session ────────────────────────────────────────────────────────

/**
 * What the agent is doing in the open session (read-only, from OpenCode):
 * `busy` working (also while retrying), `waiting` asking you or requesting a
 * permission, `idle` stopped. `since`: since when it works (ms epoch), only for
 * `busy`/`waiting`.
 */
export type SessionActivity = { state: "busy" | "idle" | "waiting"; since?: number }

// ── Render ──────────────────────────────────────────────────────────────────

/** `accent` is the active node's color; the rest come from the theme. */
export type ColorKey = "text" | "muted" | "accent" | "success" | "warning" | "error"
export type Segment = { text: string; color: ColorKey; bold?: boolean }
export type Line = Segment[]

export const SIDEBAR_WIDTH = 38
