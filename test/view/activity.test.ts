import { describe, expect, test } from "bun:test"
import type { SessionActivity, Snapshot } from "../../src/model.ts"
import { DEFAULT_INTERVALS } from "../../src/runtime/poller.ts"
import { STALE_TOLERANCE_MS } from "../../src/sources/sdd.ts"
import { compactLabel } from "../../src/view/compact.ts"
import { buildView, formatElapsed, WRITING_WINDOW_MS, writingPhase } from "../../src/view/flow-view.ts"
import { legend, renderFull } from "../../src/view/full.ts"
import { renderSidebar } from "../../src/view/sidebar.ts"
import { lineText, lineWidth } from "../../src/view/text.ts"
import { segmentsWith, texts } from "./helpers.ts"
import { CASES, NOW, change, feature, phases, snapshot } from "./snapshots.ts"

const S = 1000
const busy = (seconds: number): SessionActivity => ({ state: "busy", since: NOW - seconds * S })
const at = (snap: Snapshot, activity?: SessionActivity) => buildView(snap, NOW, activity ? { activity } : {})
const side = (snap: Snapshot, activity?: SessionActivity, width = 36) => texts(renderSidebar(at(snap, activity), width))
const compactOf = (snap: Snapshot, activity?: SessionActivity) => {
  const line = compactLabel(at(snap, activity))
  return line ? lineText(line) : undefined
}

// The agent writing the spec: spec.md exists (✓ by file) and was touched 10 s ago.
const specChange = change({
  phases: phases("dddttttt"),
  current: "spec",
  next: "design",
  nextRecommended: "design",
  phaseUpdatedAt: { propose: NOW - 200 * S, spec: NOW - 10 * S },
})
const SPEC = snapshot({ sdd: specChange })
const applyChange = change({
  phases: phases("dddddatt"),
  current: "apply",
  next: "apply",
  nextRecommended: "apply",
  tasks: { total: 16, completed: 6, pending: 10 },
  phaseUpdatedAt: { tasks: NOW - 5 * S, apply: NOW - 5 * S },
})
const APPLY = snapshot({ sdd: applyChange })

describe("formatElapsed", () => {
  test("m:ss up to an hour; after that, hours and minutes", () => {
    expect(formatElapsed(5 * S)).toBe("0:05")
    expect(formatElapsed(84 * S)).toBe("1:24")
    expect(formatElapsed(723 * S)).toBe("12:03")
    expect(formatElapsed(3725 * S)).toBe("1h 02m")
    expect(formatElapsed(-1)).toBe("0:00")
  })
})

describe("phase in progress", () => {
  test("only with the agent working and the artifact touched < 3 min ago", () => {
    expect(writingPhase(specChange, busy(84), NOW)).toBe("spec")
    expect(writingPhase(specChange, { state: "idle" }, NOW)).toBeUndefined()
    expect(writingPhase(specChange, { state: "waiting" }, NOW)).toBeUndefined()
    expect(writingPhase(specChange, undefined, NOW)).toBeUndefined()
    const old = { ...specChange, phaseUpdatedAt: { spec: NOW - WRITING_WINDOW_MS - S } }
    expect(writingPhase(old, busy(84), NOW)).toBeUndefined()
    expect(writingPhase({ ...specChange, phaseUpdatedAt: { spec: NOW - WRITING_WINDOW_MS } }, busy(1), NOW)).toBe("spec")
  })

  test("the newest wins; on the same date (tasks.md with checked tasks), the later one", () => {
    const both = { ...specChange, phaseUpdatedAt: { spec: NOW - 20 * S, design: NOW - 5 * S } }
    expect(writingPhase(both, busy(1), NOW)).toBe("design")
    expect(writingPhase(applyChange, busy(1), NOW)).toBe("apply")
  })

  test("writing the spec: ◉ in the box with «escribiendo 1:24», not ✓", () => {
    const lines = side(SPEC, busy(84))
    expect(lines).toContain(" │ ◉ spec               │")
    expect(lines).toContain(" │   escribiendo 1:24   │")
    expect(lines).not.toContain(" │ ✓ spec               │")
    expect(lines).toContain("   ▼  ◀ estás aquí")
    const mark = segmentsWith(renderSidebar(at(SPEC, busy(84)), 36), "◉")[0]!
    expect(mark.color).toBe("accent")
  })

  test("the box goes to the phase in progress even if the current one is another", () => {
    const snap = snapshot({ sdd: { ...specChange, phases: phases("dddddttt"), current: "tasks", next: "apply", phaseUpdatedAt: { propose: NOW - 30 * S } } })
    const lines = side(snap, busy(30))
    expect(lines).toContain(" │ ◉ propose            │")
    expect(lines).toContain("   ✓ tasks")
  })

  test("apply in progress: bar, «escribiendo» and the per-task loop within 36", () => {
    const lines = side(APPLY, busy(3725))
    expect(lines).toContain(" │   escribiendo 1h 02m │  │ tarea")
    expect(lines).toContain(" │   ██████░░░░░░░░░░   │  │ por")
  })

  test("working without a recent artifact: the usual view and the note under the box", () => {
    const snap = snapshot({ sdd: { ...specChange, phaseUpdatedAt: { spec: NOW - 600 * S } } })
    const lines = side(snap, busy(723))
    expect(lines).toContain(" │ ✓ spec               │")
    expect(lines).toContain("   │  agente trabajando 12:03")
    expect(lines).toContain("   ▼  ◀ estás aquí")
    // Under apply the loop runs: the short version.
    expect(side(snapshot({ sdd: { ...applyChange, phaseUpdatedAt: {} } }), busy(5))).toContain("   │  trabajando 0:05      │")
  })
})

describe("waiting for your OK", () => {
  test("asking you (waiting): on the «estás aquí» line, in yellow", () => {
    const lines = side(SPEC, { state: "waiting" })
    expect(lines).toContain("   ▼  ◀ estás aquí · esperando tu OK")
    expect(lines).toContain(" │ ✓ spec               │")
    expect(segmentsWith(renderSidebar(at(SPEC, { state: "waiting" }), 36), "esperando")[0]!.color).toBe("warning")
  })

  test("stopped (idle) with a next phase: too; without a session or a next phase, no", () => {
    expect(side(SPEC, { state: "idle" })).toContain("   ▼  ◀ estás aquí · esperando tu OK")
    expect(side(SPEC).join("\n")).not.toContain("esperando")
    expect(side(CASES.sddArchived, { state: "idle" }).join("\n")).not.toContain("esperando")
    expect(side(SPEC, busy(1)).join("\n")).not.toContain("esperando")
  })

  test("under apply it moves to the next row so it does not overlap the loop", () => {
    const lines = side(APPLY, { state: "waiting" })
    expect(lines).toContain("   │  ◀ estás aquí         │")
    expect(lines).toContain("   ▼    esperando tu OK    │")
  })
})

describe("ODD with the agent", () => {
  const ODD = snapshot({ odd: feature(), git: { kind: "repo", dirty: true } })

  test("working with uncommitted changes: «▸ trabajando m:ss» inside implement", () => {
    expect(side(ODD, busy(84))).toContain(" │   ▸ trabajando 1:24          │")
  })

  test("clean tree: counts if the document was touched < 3 min ago", () => {
    const clean = (updatedAt: number) => snapshot({ odd: feature({ updatedAt }), git: { kind: "repo", dirty: false } })
    expect(side(clean(NOW - 60 * S), busy(5))).toContain(" │   ▸ trabajando 0:05          │")
    expect(side(clean(NOW - 600 * S), busy(5)).join("\n")).not.toContain("trabajando")
  })

  test("asking you: «esperando tu OK»; stopped or no session, nothing", () => {
    expect(side(ODD, { state: "waiting" })).toContain(" │   esperando tu OK            │")
    expect(side(ODD, { state: "idle" }).join("\n")).not.toMatch(/trabajando|esperando/)
    expect(side(ODD).join("\n")).not.toMatch(/trabajando|esperando/)
  })
})

describe("compact indicator", () => {
  test("« · m:ss» working, « · esperando» if it is asking you, nothing when stopped", () => {
    expect(compactOf(SPEC, busy(84))).toBe("SDD · spec ▸ design · 1:24")
    expect(compactOf(SPEC, { state: "waiting" })).toBe("SDD · spec ▸ design · esperando")
    expect(compactOf(SPEC, { state: "idle" })).toBe("SDD · spec ▸ design")
    expect(compactOf(SPEC)).toBe("SDD · spec ▸ design")
    expect(compactOf(CASES.idle, busy(1))).toBeUndefined()
  })
})

describe("/openspec-status legend", () => {
  test("states the same rules the view applies", () => {
    const text = texts(legend(170)).join("\n")
    expect(text).toContain(`hace < ${WRITING_WINDOW_MS / 60_000} min`)
    expect(text).toContain(`> ${STALE_TOLERANCE_MS / 60_000} min después`)
    expect(text).toContain(`cada ${DEFAULT_INTERVALS.sdd / 1000} s`)
    expect(text).toContain("esperando tu OK: el agente paró o te pregunta")
  })

  test("shows in the overview when something is active and fits every width", () => {
    for (const width of [40, 60, 100, 170]) {
      const lines = renderFull(at(SPEC, busy(1)), width)
      expect(texts(lines).join("\n")).toContain("cuándo cambia cada marca")
      for (const line of legend(width)) expect(lineWidth(line)).toBeLessThanOrEqual(width)
    }
    expect(texts(renderFull(at(CASES.idle), 60)).join("\n")).not.toContain("cuándo cambia")
  })
})

describe("«por tarea» with apply outside the box", () => {
  test("at 36 columns it goes left of the loop, in full", () => {
    for (const snap of [CASES.sddSpecs, CASES.sddTasksZero]) {
      const lines = side(snap)
      expect(lines).toContain("   ▼             por tarea │")
      expect(lines.join("\n")).not.toContain("por ta…")
    }
  })

  test("at 38 it stays on the right", () => {
    expect(side(CASES.sddSpecs, undefined, 38)).toContain("   ▼                       │ por tarea")
  })
})

describe("widths with activity", () => {
  const cases: [string, Snapshot, SessionActivity][] = [
    ["spec escribiendo", SPEC, busy(84)],
    ["spec esperando", SPEC, { state: "waiting" }],
    ["spec parado", SPEC, { state: "idle" }],
    ["apply escribiendo 1 h", APPLY, busy(3725)],
    ["apply esperando", APPLY, { state: "waiting" }],
    ["apply trabajando", snapshot({ sdd: { ...applyChange, phaseUpdatedAt: {} } }), busy(3725)],
    ["ODD trabajando", snapshot({ odd: feature(), sdd: specChange, git: { kind: "repo", dirty: true } }), busy(3725)],
    ["ODD esperando", snapshot({ odd: feature(), sdd: applyChange }), { state: "waiting" }],
  ]
  for (const [name, snap, activity] of cases) {
    test(name, () => {
      const v = at(snap, activity)
      for (const width of [36, 38]) {
        for (const line of renderSidebar(v, width)) expect(lineWidth(line), `${name} @${width}: «${lineText(line)}»`).toBeLessThanOrEqual(width)
        // Nothing clipped at the end (the ODD path is shortened inside on purpose).
        expect(texts(renderSidebar(v, width)).join("\n")).not.toMatch(/…$/m)
      }
      for (const width of [40, 60, 100, 170]) {
        for (const line of renderFull(v, width)) expect(lineWidth(line), `${name} @${width}: «${lineText(line)}»`).toBeLessThanOrEqual(width)
      }
    })
  }
})
