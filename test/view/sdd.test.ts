import { describe, expect, test } from "bun:test"
import { renderSidebar } from "../../src/view/sidebar.ts"
import { staleSummary } from "../../src/view/sdd.ts"
import { displayWidth } from "../../src/view/text.ts"
import { compact, segmentsWith, sidebar, sidebarText, texts, view } from "./helpers.ts"
import { CASES } from "./snapshots.ts"

const row = (lines: string[], text: string) => lines.find((l) => l.includes(text))

describe("SDD in every phase", () => {
  test("proposal only: propose in the box and spec as next", () => {
    const lines = sidebar(CASES.sddProposal)
    expect(lines).toContain(" │ ✓ propose            │")
    expect(lines).toContain("   ○ spec  ▸ siguiente")
    expect(lines.at(-1)).toBe(" ▸ luego: spec")
  })

  test("specs: spec in the box, design next", () => {
    const lines = sidebar(CASES.sddSpecs)
    expect(lines).toContain(" │ ✓ spec               │")
    expect(lines).toContain("   ○ design  ▸ siguiente")
  })

  test("design: design in the box, tasks next", () => {
    const lines = sidebar(CASES.sddDesign)
    expect(lines).toContain(" │ ✓ design             │")
    expect(lines).toContain("   ○ tasks  ▸ siguiente")
  })

  test("tasks 0/16: apply next with the count on the node and the loop off", () => {
    const lines = sidebar(CASES.sddTasksZero)
    expect(lines).toContain(" │ ✓ tasks              │")
    // No room for both count and note before the loop: the note stays.
    expect(lines).toContain("   ○ apply  ▸ siguiente ◀──┐")
    expect(row(lines, "ahora")).toBe(" ▸ ahora: 1.1 crear la tabla de caché")
    const loop = renderSidebar(view(CASES.sddTasksZero)).flat().filter((s) => s.text === "┐")
    expect(loop.length).toBe(1)
    expect(loop[0]!.color).toBe("muted")
  })

  test("apply 6/16: box with a progress bar and the per-task loop on", () => {
    const lines = renderSidebar(view(CASES.sddApply))
    const text = lines.map((l) => l.map((s) => s.text).join(""))
    expect(text).toContain(" │ ◉ apply  6/16        │◀─┐")
    expect(text).toContain(" │   ██████░░░░░░░░░░   │  │ por")
    expect(segmentsWith(lines, "◀").find((s) => s.text === "◀")!.color).toBe("accent")
    expect(segmentsWith(lines, "apply").find((s) => s.text === "apply")).toEqual({ text: "apply", color: "accent", bold: true })
    expect(text.at(-1)).toBe(" ▸ luego: seguir apply (10 pend.)")
  })

  test("all tasks done: apply 16/16 with a full bar and archive as next", () => {
    const lines = sidebar(CASES.sddAllDone)
    expect(lines).toContain(" │ ✓ apply  16/16       │◀─┐")
    expect(lines).toContain(" │   ████████████████   │  │ por")
    expect(lines).toContain("   ○ archive  ▸ siguiente")
    const corner = renderSidebar(view(CASES.sddAllDone)).flat().filter((s) => s.text === "┐")
    expect(corner.length).toBe(1)
    expect(corner[0]!.color).toBe("muted")
  })

  test("verified: verify in the box with the «falla» loop leaving it", () => {
    const lines = sidebar(CASES.sddVerified)
    expect(lines).toContain("   ✓ apply  16/16 ◀────────┐")
    expect(lines).toContain(" │ ✓ verify             │──┘ falla")
    expect(lines).toContain("   ○ archive  ▸ siguiente")
  })

  test("archived: the last box has «estás aquí» beside it and ends without an exit", () => {
    const lines = sidebar(CASES.sddArchived)
    expect(lines).toContain(" │ ✓ archive            │ ◀ estás aquí")
    expect(lines).toContain(" └──────────────────────┘")
    expect(lines.at(-1)).toBe(" ▸ luego: sdd-new")
  })
})

test("blocked like venue-finder: spec ○ next, tasks ✓, apply ✗ 4/15 and reasons in red", () => {
  const lines = renderSidebar(view(CASES.sddBlocked))
  const text = lines.map((l) => l.map((s) => s.text).join(""))
  expect(text).toContain("   ✓ propose")
  expect(text).toContain("   ○ spec  ▸ siguiente")
  expect(text).toContain("   ✓ tasks")
  expect(text).toContain(" │ ✗ apply  4/15        │◀─┐")
  expect(text).toContain(" ✗ apply tiene 4/15 tareas hechas pero")
  expect(text).toContain("   … y 1 más")
  expect(segmentsWith(lines, "apply tiene").every((s) => s.color === "error")).toBe(true)
  expect(compact(CASES.sddBlocked)).toBe("SDD ✗ bloqueado")
})

describe("artifact drift", () => {
  test("the arrow goes from spec to tasks with «cambió tras tasks» and «revisar» in the warning color", () => {
    const lines = renderSidebar(view(CASES.sddApply))
    const text = lines.map((l) => l.map((s) => s.text).join(""))
    expect(text).toContain("   ✓ spec ─────────┐ ⚠ cambió")
    expect(text).toContain("   ▼               │   tras tasks")
    expect(text).toContain("   ▼               ▼")
    expect(text).toContain("   ✓ tasks ◀─ revisar")
    expect(segmentsWith(lines, "revisar").every((s) => s.color === "warning")).toBe(true)
  })

  test("store without files: muted «desfase: no disponible» and no arrow", () => {
    const lines = sidebar(CASES.sddStaleUnavailable)
    expect(lines).toContain("   desfase: no disponible (engram)")
    expect(lines.some((l) => l.includes("cambió"))).toBe(false)
  })

  test("several warnings: the arrow for the first pair and one summary over the first affected artifact", () => {
    const lines = sidebar(CASES.sddStaleMany)
    expect(lines).toContain("   ✓ spec ─────────┐ ⚠ cambió")
    expect(lines.join("\n")).toContain(" ⚠ propose y spec cambiaron tras tasks\n   → revisa tasks y lo que viene\n   después")
    expect(lines.filter((l) => l.startsWith(" ⚠"))).toHaveLength(1)
  })

  test("if the arrow does not fit (the box is in between) it is summarized below", () => {
    const lines = sidebar(CASES.sddStaleBoxed)
    expect(lines).toContain(" │ ✓ design             │")
    expect(lines.join("\n")).toContain(" ⚠ spec cambió tras tasks → revisa\n   tasks")
    expect(lines.some((l) => l.includes("┐ ⚠ cambió"))).toBe(false)
  })
})

describe("several changes: «(1 de N)» with the reason", () => {
  test("if the name does not fit with «(1 de 2)», that moves to its own line", () => {
    const [head, count, blank] = sidebar(CASES.sddChoice)
    expect(head).toBe(" ◆ SDD · un-cambio-con-nombre-muy-lar…")
    expect(count).toBe("   (1 de 2)")
    expect(blank).toBe("")
  })

  test("the branch's and the pinned one say so; on the same line if it fits", () => {
    expect(sidebar(CASES.sddChoiceBranch).slice(0, 2)).toEqual([" ◆ SDD · fidelizacion-puntos", "   (1 de 6 · rama)"])
    expect(sidebar(CASES.sddChoicePinned)[0]).toBe(" ◆ SDD · cafe (1 de 6 · fijado)")
    const full = view(CASES.sddChoiceBranch)
    expect(texts(renderSidebar(full, 60))[0]).toBe(" ◆ SDD · fidelizacion-puntos (1 de 6 · rama)")
  })

  test("never exceeds the width", () => {
    for (const snapshot of [CASES.sddChoice, CASES.sddChoiceBranch, CASES.sddChoicePinned]) {
      for (const width of [20, 30, 36, 38, 60]) {
        for (const line of texts(renderSidebar(view(snapshot), width))) expect(displayWidth(line), `@${width} «${line}»`).toBeLessThanOrEqual(width)
      }
    }
  })
})

test("incoherent: no diagram, only the reasons", () => {
  const lines = sidebar(CASES.sddIncoherent)
  expect(lines[0]).toBe(" ◆ SDD")
  expect(lines).toContain(" ⚠ sdd-status incoherente:")
  expect(lines).toContain(" · falta changeName")
  expect(lines).toContain("   … y 1 más")
  expect(lines.some((l) => l.includes("▼"))).toBe(false)
})

test("unknown format: says so with the schema and draws nothing", () => {
  const lines = sidebar(CASES.sddUnsupported)
  expect(lines.join("\n")).toContain("formato desconocido:")
  expect(lines.join("\n")).toContain("gentle-ai.sdd-status@3")
  expect(lines.some((l) => l.includes("▼"))).toBe(false)
})

test("pinned layout: the SDD example from the approved sketch", () => {
  expect(sidebarText(CASES.sddApply)).toBe(
    [
      " ◆ SDD · add-price-cache",
      "",
      "   ✓ explore",
      "   ▼",
      "   ✓ propose",
      "   ▼",
      "   ✓ spec ─────────┐ ⚠ cambió",
      "   ▼               │   tras tasks",
      "   ✓ design        │",
      "   ▼               ▼",
      "   ✓ tasks ◀─ revisar",
      "   ▼",
      " ┌──────────────────────┐",
      " │ ◉ apply  6/16        │◀─┐",
      " │   ██████░░░░░░░░░░   │  │ por",
      " └─┬────────────────────┘  │ tarea",
      "   ▼  ◀ estás aquí         │",
      "   ○ verify ───────────────┘ falla",
      "   ▼",
      "   ○ archive",
      "",
      " ▸ ahora: 2.3 cachear precios por",
      "   región",
      " ▸ luego: seguir apply (10 pend.)",
    ].join("\n"),
  )
})

test("drift summary: the action depends on the affected phase", () => {
  const pair = (upstream: "propose" | "spec" | "design", downstream: "tasks" | "apply" | "verify") => ({ upstream, downstream, warnings: [] })
  expect(staleSummary([pair("spec", "tasks")])).toBe("spec cambió tras tasks → revisa tasks")
  expect(staleSummary([pair("propose", "apply"), pair("design", "apply")])).toBe(
    "propose y design cambiaron tras apply → comprueba que lo ya aplicado sigue valiendo",
  )
  expect(staleSummary([pair("spec", "verify")])).toBe("spec cambió tras verify → repite verify")
})
