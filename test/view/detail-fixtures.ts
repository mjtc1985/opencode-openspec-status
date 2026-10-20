// Models for the SDD detail tests: the detail comes from the synthetic
// `openspec-synth-detail` fixtures through the pure parsers (no reader).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PhaseStatus, SddChange, SddPhaseId } from "../../src/model.ts"
import { parseApplyProgress, parseDesign, parseProposal, parseSpec, parseTasks, parseVerifyReport, type SddDetail } from "../../src/sources/sdd-detail.ts"
import type { DetailModel } from "../../src/view/sdd-detail.ts"

const FIX = join(import.meta.dir, "..", "fixtures", "openspec-synth-detail")
const raw = (path: string) => readFileSync(join(FIX, path), "utf8")

/** 2026-09-30 10:42 and 09:15 local time. */
export const T_SPECS = new Date(2026, 8, 30, 10, 42).getTime()
export const T_TASKS = new Date(2026, 8, 30, 9, 15).getTime()

const DIR = "openspec/changes/add-price-cache"
const EMPTY_FILES: SddDetail["files"] = { proposal: [], specs: [], design: [], tasks: [], applyProgress: [], verifyReport: [] }

export function priceCacheDetail(): SddDetail {
  const spec = (cap: string) => parseSpec(raw(`add-price-cache/specs/${cap}/spec.md`), cap, `${DIR}/specs/${cap}/spec.md`)
  return {
    change: "add-price-cache",
    changeDir: DIR,
    proposal: parseProposal(raw("add-price-cache/proposal.md")),
    specs: [spec("price-cache"), spec("pricing-api")],
    design: parseDesign(raw("add-price-cache/design.md")),
    tasks: parseTasks(raw("add-price-cache/tasks.md")),
    applyProgress: parseApplyProgress(raw("add-price-cache/apply-progress.md")),
    verify: parseVerifyReport(raw("add-price-cache/verify-report.md")),
    workItem: { ref: "AB#48213", system: "azure-devops", id: "48213", url: "https://dev.azure.com/contoso/Tienda/_workitems/edit/48213", source: "openspec-yaml" },
    files: {
      proposal: [{ path: `${DIR}/proposal.md` }],
      specs: [{ path: `${DIR}/specs/price-cache/spec.md` }, { path: `${DIR}/specs/pricing-api/spec.md` }],
      design: [{ path: `${DIR}/design.md` }],
      tasks: [{ path: `${DIR}/tasks.md`, mtime: T_TASKS }],
      applyProgress: [{ path: `${DIR}/apply-progress.md` }],
      verifyReport: [{ path: `${DIR}/verify-report.md` }],
    },
  }
}

/** Only proposal and tasks, no work item. */
export function omDecimalsDetail(): SddDetail {
  const dir = "openspec/changes/fix-om-decimals"
  return {
    change: "fix-om-decimals",
    changeDir: dir,
    proposal: parseProposal(raw("fix-om-decimals/proposal.md")),
    specs: [],
    tasks: parseTasks(raw("fix-om-decimals/tasks.md")),
    files: { ...EMPTY_FILES, proposal: [{ path: `${dir}/proposal.md` }], tasks: [{ path: `${dir}/tasks.md` }] },
  }
}

function phases(done: SddPhaseId[], extra: Partial<Record<SddPhaseId, PhaseStatus>> = {}): Record<SddPhaseId, PhaseStatus> {
  const all = ["explore", "propose", "spec", "design", "tasks", "apply", "verify", "archive"] as const
  return Object.fromEntries(all.map((p) => [p, extra[p] ?? (done.includes(p) ? "done" : "todo")])) as Record<SddPhaseId, PhaseStatus>
}

export function priceCacheStatus(overrides: Partial<SddChange> = {}): SddChange {
  return {
    kind: "change",
    name: "add-price-cache",
    store: "openspec",
    phases: phases(["explore", "propose", "spec", "design", "tasks"], { apply: "active" }),
    current: "apply",
    next: "apply",
    nextRecommended: "apply",
    tasks: { total: 16, completed: 6, pending: 10 },
    currentTask: "2.3 Cachear precios por región",
    blocked: [],
    stale: [
      {
        upstream: "specs",
        downstream: "tasks",
        upstreamFile: `/r/${DIR}/specs/price-cache/spec.md`,
        upstreamMtime: T_SPECS,
        downstreamFile: `/r/${DIR}/tasks.md`,
        downstreamMtime: T_TASKS,
      },
    ],
    notes: [],
    ...overrides,
  }
}

export function omDecimalsStatus(overrides: Partial<SddChange> = {}): SddChange {
  return {
    kind: "change",
    name: "fix-om-decimals",
    store: "openspec",
    phases: phases(["explore", "propose", "tasks"]),
    current: "spec",
    next: "design",
    nextRecommended: "design",
    tasks: { total: 2, completed: 0, pending: 2 },
    blocked: [],
    stale: [],
    notes: [],
    ...overrides,
  }
}

export function twoChanges(): DetailModel {
  return {
    changes: [
      { status: priceCacheStatus(), detail: priceCacheDetail() },
      { status: omDecimalsStatus(), detail: omDecimalsDetail() },
    ],
  }
}
