// Hand-written snapshots (typed against the contract) to test the view without
// depending on the `src/sources` parsers.
import {
  SDD_PHASES,
  type GitState,
  type OddFeature,
  type OddState,
  type OddTask,
  type PhaseStatus,
  type Review,
  type ReviewState,
  type SddChange,
  type SddPhaseId,
  type SddState,
  type Snapshot,
  type Sourced,
} from "../../src/model.ts"

export const ROOT = "/home/ana/proyecto"
export const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime()

const STATUS: Record<string, PhaseStatus> = { d: "done", a: "active", t: "todo", b: "blocked" }

/** `phases("dddddatt")`: one letter per phase (d done, a active, t todo, b blocked). */
export function phases(spec: string): Record<SddPhaseId, PhaseStatus> {
  return Object.fromEntries(SDD_PHASES.map((p, i) => [p, STATUS[spec[i] ?? "t"]!])) as Record<SddPhaseId, PhaseStatus>
}

export function change(overrides: Partial<SddChange> = {}): SddChange {
  return {
    kind: "change",
    name: "add-price-cache",
    store: "openspec",
    phases: phases("dttttttt"),
    current: "explore",
    nextRecommended: "propose",
    next: "propose",
    tasks: { total: 0, completed: 0, pending: 0 },
    blocked: [],
    stale: [],
    notes: [],
    ...overrides,
  }
}

export function tasks(spec: string): OddTask[] {
  // `spec`: one letter per task (d done, a active, t todo).
  const status = { d: "done", a: "active", t: "todo" } as const
  return [...spec].map((c, i) => ({ id: `T${i + 1}`, title: `tarea número ${i + 1}`, status: status[c as "d" | "a" | "t"] }))
}

export function feature(overrides: Partial<OddFeature> = {}): OddFeature {
  const list = overrides.tasks ?? tasks("ddat")
  return {
    kind: "feature",
    file: "odd/tasks/sample-app-skeleton.md",
    title: "sample-app-skeleton",
    tasks: list,
    current: list.find((t) => t.status === "active"),
    allDone: list.length > 0 && list.every((t) => t.status === "done"),
    warnings: [],
    ...overrides,
  }
}

export function review(overrides: Partial<Review> = {}): Review {
  return {
    kind: "review",
    lineageId: "review-ff3e92437e221e59",
    state: "reviewing",
    entryStatus: "active",
    riskLevel: "high",
    lenses: null,
    applies: "current",
    ...overrides,
  }
}

type Parts = { sdd?: SddState; odd?: OddState; review?: ReviewState; git?: GitState }
type StaleParts = Partial<Record<keyof Parts, { since: number; error: string }>>

function sourced<T>(value: T, stale?: { since: number; error: string }): Sourced<T> {
  return stale ? { value, stale } : { value }
}

export function snapshot(parts: Parts = {}, stale: StaleParts = {}): Snapshot {
  return {
    root: ROOT,
    sdd: sourced(parts.sdd ?? { kind: "none" }, stale.sdd),
    odd: sourced(parts.odd ?? { kind: "none" }, stale.odd),
    review: sourced(parts.review ?? { kind: "none" }, stale.review),
    git: sourced(parts.git ?? { kind: "repo", dirty: false }, stale.git),
  }
}

// ── The examples from the approved sketch ────────────────────────────────────

const min = 60_000

export const sddExample = change({
  phases: phases("dddddatt"),
  current: "apply",
  next: "apply",
  nextRecommended: "apply",
  tasks: { total: 16, completed: 6, pending: 10 },
  currentTask: "2.3 cachear precios por región",
  stale: [
    {
      upstream: "specs",
      downstream: "tasks",
      upstreamFile: `${ROOT}/openspec/changes/add-price-cache/specs/cache/spec.md`,
      upstreamMtime: NOW - 5 * min,
      downstreamFile: `${ROOT}/openspec/changes/add-price-cache/tasks.md`,
      downstreamMtime: NOW - 30 * min,
    },
  ],
})

const sampleAppTasks: OddTask[] = [
  { id: "T1", title: "Scaffold", status: "done" },
  { id: "T2", title: "Core", status: "done" },
  { id: "T3", title: "Server plugin", status: "done" },
  { id: "T4", title: "TUI plugin", status: "done" },
  { id: "T5", title: "Content", status: "done" },
  { id: "T6", title: "Installer", status: "done" },
  { id: "T8", title: "Reduce bash friction while exploring", status: "todo" },
  { id: "T9", title: "TUI flow diagram in the sidebar", status: "todo" },
  { id: "T7", title: "Installer (partial)", status: "active" },
]

export const oddExample = feature({
  tasks: sampleAppTasks,
  current: sampleAppTasks[8],
  allDone: false,
  nextStep: "capturar la TUI con pyte y revisar el borde de la caja activa antes del commit",
})

export const reviewExample = review({
  state: "correction_required",
  lenses: [
    { lens: "review-risk", status: "findings", findings: 4 },
    { lens: "review-resilience", status: "findings", findings: 3 },
    { lens: "review-readability", status: "ok" },
    { lens: "review-reliability", status: "running" },
  ],
})

// ── Case catalog: the width tests walk all of them ──────────────────────────

const staleWarning = (upstream: "proposal" | "specs" | "design", downstream: "tasks" | "applyProgress" | "verifyReport", agoMin: number) => ({
  upstream,
  downstream,
  upstreamFile: `${ROOT}/openspec/changes/add-price-cache/${upstream}.md`,
  upstreamMtime: NOW - agoMin * min,
  downstreamFile: `${ROOT}/openspec/changes/add-price-cache/${downstream}.md`,
  downstreamMtime: NOW - 120 * min,
})

const sixteen = (completed: number) => ({ total: 16, completed, pending: 16 - completed })

// Pinned (focus): the SDD change or ODD feature pinned for the branch.
const SIX = { index: 1, total: 6, others: ["a", "b", "c", "d", "e"] }
export const sddPinned = change({ ...sddExample, name: "ticket-digital", choice: { ...SIX, reason: "pinned" }, pinned: true })
const sddOfBranch = change({ ...sddExample, name: "ticket-digital", choice: { ...SIX, reason: "branch" } })
export const oddPinned = feature({ ...oddExample, title: "modo-oscuro-carta", file: "odd/tasks/modo-oscuro-carta.md", pinned: true })

// Automatic focus (nothing pinned): the branch's methodology or the newest.
export const oddDemo = feature({ ...oddExample, title: "modo-oscuro-carta", file: "odd/tasks/modo-oscuro-carta.md" })
const sddDemo = change({ ...sddExample, name: "fidelizacion-puntos", choice: { ...SIX, reason: "branch" }, branchMatch: { by: "workItem", length: 19 } })
const early = NOW - 60 * min
const late = NOW - min

export const CASES = {
  // SDD in every phase
  sddProposal: snapshot({ sdd: change({ phases: phases("ddtttttt"), current: "propose", next: "spec", nextRecommended: "spec" }) }),
  sddSpecs: snapshot({ sdd: change({ phases: phases("dddttttt"), current: "spec", next: "design", nextRecommended: "design" }) }),
  sddDesign: snapshot({ sdd: change({ phases: phases("ddddtttt"), current: "design", next: "tasks", nextRecommended: "tasks" }) }),
  sddTasksZero: snapshot({ sdd: change({ phases: phases("dddddttt"), current: "tasks", next: "apply", nextRecommended: "apply", tasks: sixteen(0), currentTask: "1.1 crear la tabla de caché" }) }),
  sddApply: snapshot({ sdd: sddExample }),
  sddAllDone: snapshot({ sdd: change({ phases: phases("ddddddtt"), current: "apply", next: "archive", nextRecommended: "archive", tasks: sixteen(16) }) }),
  sddVerified: snapshot({ sdd: change({ phases: phases("dddddddt"), current: "verify", next: "archive", nextRecommended: "archive", tasks: sixteen(16) }) }),
  sddArchived: snapshot({ sdd: change({ phases: phases("dddddddd"), current: "archive", next: undefined, nextRecommended: "sdd-new", tasks: sixteen(16) }) }),
  // Like venue-finder: tasks done without spec or design, apply half done and blocked.
  sddBlocked: snapshot({
    sdd: change({
      name: "find-alternative-venue",
      phases: { explore: "todo", propose: "done", spec: "todo", design: "todo", tasks: "done", apply: "blocked", verify: "todo", archive: "todo" },
      current: "apply",
      next: "spec",
      nextRecommended: "spec",
      tasks: { total: 15, completed: 4, pending: 11 },
      currentTask: "1.5 buscar alternativas por distancia",
      blocked: ["apply tiene 4/15 tareas hechas pero faltan spec y design", "specs vacío", "design vacío"],
    }),
  }),
  sddStaleUnavailable: snapshot({ sdd: change({ ...sddExample, store: "engram", stale: "unavailable" }) }),
  sddStaleMany: snapshot({
    sdd: change({
      phases: phases("ddddddat"),
      current: "verify",
      next: "archive",
      nextRecommended: "archive",
      tasks: sixteen(16),
      stale: [staleWarning("design", "verifyReport", 3), staleWarning("specs", "applyProgress", 8), staleWarning("specs", "tasks", 8), staleWarning("proposal", "tasks", 20)],
    }),
  }),
  sddStaleBoxed: snapshot({ sdd: change({ phases: phases("ddddtttt"), current: "design", next: "tasks", nextRecommended: "tasks", stale: sddExample.stale }) }),
  sddChoice: snapshot({ sdd: change({ ...sddExample, name: "un-cambio-con-nombre-muy-largo-para-la-sidebar", choice: { index: 1, total: 2, others: ["otro-cambio"] } }) }),
  sddChoiceBranch: snapshot({ sdd: change({ ...sddExample, name: "fidelizacion-puntos", choice: { index: 1, total: 6, others: ["a", "b", "c", "d", "e"], reason: "branch" } }) }),
  sddChoicePinned: snapshot({ sdd: change({ ...sddExample, name: "cafe", choice: { index: 1, total: 6, others: ["a", "b", "c", "d", "e"], reason: "pinned" } }) }),
  sddIncoherent: snapshot({ sdd: { kind: "incoherent", reasons: ["taskProgress dice 17 de 16 tareas completadas", "artifacts.tasks es done pero no hay tasks.md", "falta changeName", "schemaVersion ausente"] } }),
  sddUnsupported: snapshot({ sdd: { kind: "unsupported", schema: "gentle-ai.sdd-status@3" } }),

  // ODD
  oddExample: snapshot({ odd: oddExample, review: reviewExample, git: { kind: "repo", dirty: true } }),
  oddAllDone: snapshot({ odd: feature({ tasks: tasks("dddd"), current: undefined, allDone: true, nextStep: "abrir la PR" }) }),
  oddWarnings: snapshot({ odd: feature({ warnings: ["línea 40: casilla sin id de tarea", "sección «Next step» no encontrada", "tarea T9 repetida"] }) }),
  oddLong: snapshot({
    odd: feature({
      title: "Feature: una-feature-con-un-nombre-larguísimo-de-verdad",
      file: "odd/tasks/una-feature-con-un-nombre-larguísimo-de-verdad.md",
      tasks: tasks("d".repeat(20) + "a" + "t".repeat(19)).map((t) => ({ ...t, title: `${t.title} con un título larguísimo que no cabe en ninguna sidebar` })),
      nextStep: "seguir con la siguiente tarea larga que tampoco cabe en dos líneas de la sidebar ni de broma",
    }),
  }),
  oddDirty: snapshot({ odd: feature(), git: { kind: "repo", dirty: true } }),
  oddClean: snapshot({ odd: feature(), git: { kind: "repo", dirty: false } }),
  oddNoGit: snapshot({ odd: feature(), review: { kind: "unavailable", reason: "sin .git" }, git: { kind: "none" } }),
  oddCorrection: snapshot({ odd: feature(), review: review({ state: "correction_required" }), git: { kind: "repo", dirty: true } }),
  oddReviewing: snapshot({ odd: feature(), review: review({ state: "reviewing" }), git: { kind: "repo", dirty: true } }),
  oddApproved: snapshot({ odd: feature(), review: review({ state: "approved" }), git: { kind: "repo", dirty: false } }),

  // Review in its own block
  reviewStop: snapshot({
    sdd: sddExample,
    review: review({
      state: "reviewing",
      lenses: [
        { lens: "risk", status: "ok" },
        { lens: "resilience", status: "running" },
      ],
      stop: { kind: "stop", reasonCode: "captured_artifacts_unverifiable", description: "los artefactos capturados no se pueden verificar" },
    }),
  }),
  reviewStopNoDescription: snapshot({ review: review({ state: "reviewing", stop: { kind: "stop", reasonCode: "consent_required" } }) }),
  reviewOther: snapshot({ sdd: sddExample, review: review({ state: "correction_required", applies: "other", lenses: [{ lens: "risk", status: "findings", findings: 1 }] }) }),
  reviewNoLenses: snapshot({ sdd: sddExample, review: review({ state: "approved", lenses: null }) }),
  reviewUnavailable: snapshot({ sdd: sddExample, review: { kind: "unavailable", reason: "sin .git" } }),
  reviewIncoherent: snapshot({ sdd: sddExample, review: { kind: "incoherent", reasons: ["dos entradas activas para el mismo linaje"] } }),

  // Pinned
  focusSdd: snapshot({ sdd: sddPinned, odd: oddExample, review: reviewExample, git: { kind: "repo", dirty: true } }),
  focusSddSingle: snapshot({ sdd: change({ ...sddExample, pinned: true }), odd: feature() }),
  focusSddSingleLong: snapshot({ sdd: change({ ...sddExample, name: "un-cambio-con-nombre-muy-largo-para-la-sidebar", pinned: true }), odd: feature() }),
  focusSddAlone: snapshot({ sdd: sddPinned, review: reviewExample }),
  focusOdd: snapshot({ odd: oddPinned, sdd: sddOfBranch, review: reviewExample, git: { kind: "repo", dirty: true } }),
  focusOddSingleSdd: snapshot({ odd: oddPinned, sdd: change({ ...sddExample, phases: phases("dddttttt"), current: "spec", next: "design", nextRecommended: "design", tasks: sixteen(0), stale: [] }) }),
  focusOddAllDone: snapshot({ odd: feature({ tasks: tasks("dddd"), current: undefined, allDone: true, pinned: true }), sdd: sddOfBranch }),
  focusOddAlone: snapshot({ odd: oddPinned }),
  focusOddIncoherent: snapshot({ odd: oddPinned, sdd: { kind: "incoherent", reasons: ["falta changeName"] } }),
  focusOddLong: snapshot({
    odd: feature({ title: "Feature: una-feature-con-un-nombre-larguísimo-de-verdad", file: "odd/tasks/una-feature-con-un-nombre-larguísimo-de-verdad.md", pinned: true }),
    sdd: change({ ...sddOfBranch, name: "un-cambio-con-nombre-muy-largo-para-la-sidebar" }),
  }),
  focusStale: snapshot({ odd: oddPinned, sdd: sddOfBranch }, { odd: { since: NOW - 40_000, error: "timeout tras 5 s" } }),

  // Pinned as new (started during the session): «nuevo» instead of «fijado».
  focusSddNew: snapshot({ sdd: change({ ...sddExample, name: "prueba-nueva", choice: { ...SIX, total: 7, reason: "pinned" }, pinned: true, pinnedNew: true }), odd: oddExample }),
  focusSddNewLong: snapshot({
    sdd: change({ ...sddExample, name: "un-cambio-con-nombre-muy-largo-para-la-sidebar", choice: { ...SIX, total: 7, reason: "pinned" }, pinned: true, pinnedNew: true }),
    odd: oddExample,
  }),
  focusSddNewSingle: snapshot({ sdd: change({ ...sddExample, pinned: true, pinnedNew: true }), odd: feature() }),
  focusOddNew: snapshot({ odd: feature({ ...oddExample, title: "otra-feature", file: "odd/tasks/otra-feature.md", pinned: true, pinnedNew: true }), sdd: sddOfBranch }),
  focusOddNewLong: snapshot({
    odd: feature({ title: "Feature: una-feature-con-un-nombre-larguísimo-de-verdad", file: "odd/tasks/una-feature-con-un-nombre-larguísimo-de-verdad.md", pinned: true, pinnedNew: true }),
    sdd: sddOfBranch,
  }),

  // Automatic focus
  autoSddBranch: snapshot({ sdd: { ...sddDemo, updatedAt: early }, odd: { ...oddDemo, updatedAt: late }, review: reviewExample, git: { kind: "repo", dirty: true } }),
  autoOddBranch: snapshot({
    sdd: change({ ...sddExample, updatedAt: late }),
    odd: feature({ ...oddDemo, branchMatch: { by: "name", length: 17 }, updatedAt: early }),
    review: reviewExample,
    git: { kind: "repo", dirty: true },
  }),
  autoSddRecent: snapshot({ sdd: change({ ...sddExample, updatedAt: late }), odd: feature({ ...oddDemo, updatedAt: early }) }),
  autoSddRecentChoice: snapshot({ sdd: change({ ...sddExample, name: "ticket-digital", choice: { ...SIX, reason: "recent" }, updatedAt: late }), odd: feature({ ...oddDemo, updatedAt: early }) }),
  autoOddRecent: snapshot({ sdd: change({ ...sddExample, name: "ticket-digital", choice: { ...SIX, reason: "recent" }, updatedAt: early }), odd: feature({ ...oddDemo, updatedAt: late }) }),
  autoOddLong: snapshot({
    sdd: change({ ...sddExample, updatedAt: late }),
    odd: feature({ title: "Feature: una-feature-con-un-nombre-larguísimo-de-verdad", file: "odd/tasks/una-feature-con-un-nombre-larguísimo-de-verdad.md", branchMatch: { by: "name", length: 45 } }),
  }),
  autoNoDate: snapshot({ sdd: change({ ...sddExample, updatedAt: late }), odd: oddDemo }),

  // Other
  idle: snapshot(),
  idleStale: snapshot({}, { sdd: { since: NOW - 40_000, error: "timeout tras 5 s" } }),
  both: snapshot({ odd: oddExample, sdd: sddExample, review: reviewExample, git: { kind: "repo", dirty: true } }, { review: { since: NOW - 125_000, error: "exit 1" } }),
} satisfies Record<string, Snapshot>

export type CaseName = keyof typeof CASES
