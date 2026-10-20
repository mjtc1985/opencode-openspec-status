import { describe, expect, test } from "bun:test"
import type { Line } from "../../src/model.ts"
import { renderSidebar } from "../../src/view/sidebar.ts"
import { lineText } from "../../src/view/text.ts"
import { sidebar, sidebarText, view } from "./helpers.ts"
import { CASES } from "./snapshots.ts"

const lines = (name: keyof typeof CASES) => renderSidebar(view(CASES[name]))
/** Exact segment inside the cycle row that contains `row`. */
function cycleSegment(all: Line[], row: string, text: string) {
  const line = all.find((l) => lineText(l).includes(row))!
  return line.find((s) => s.text === text)!
}

test("feature with a half-done task: «inferido» header, protocol done and the implement box", () => {
  const text = sidebar(CASES.oddExample)
  expect(text[0]).toBe(" ◆ ODD · sample-app-skeleton  inferido")
  expect(text[0]!.length).toBe(38)
  expect(text).toContain("   ✓ tareas  odd/tasks/sample-….md (9)")
  expect(text).toContain(" │ ◉ implementar · T7 de 9      │")
  expect(text).toContain("   ○ cerrar  (2 pendientes)")
  expect(text).toContain(" ▸ ahora: T7 Installer (partial)")
})

test("all done: implement ✓ and close becomes the current box", () => {
  const text = sidebar(CASES.oddAllDone)
  expect(text).toContain("   ✓ implementar · 4 de 4")
  expect(text).toContain(" │ ◉ cerrar             │ ◀ estás aquí")
  expect(text.some((l) => l.includes("código"))).toBe(false)
  expect(text.at(-1)).toBe(" ▸ luego: abrir la PR")
})

test("parser warnings: muted, at most two and the rest counted", () => {
  const all = lines("oddWarnings")
  const text = all.map(lineText)
  expect(text).toContain(" ⚠ línea 40: casilla sin id de tarea")
  expect(text).toContain("   … y 1 más")
  const warning = all.find((l) => lineText(l).includes("casilla"))!
  expect(warning.every((s) => s.color === "muted")).toBe(true)
})

test("long titles and many tasks: clipped with «…» never past 38", () => {
  const text = sidebar(CASES.oddLong)
  expect(text[0]).toBe(" ◆ ODD · una-feature-con-un…  inferido")
  expect(text).toContain("   ✓ tareas  odd/tasks/una-fe….md (40)")
  expect(text).toContain(" │ ◉ implementar · T21 de 40    │")
  expect(text).toContain("   ○ cerrar  (19 pendientes)")
  const now = text.findIndex((l) => l.startsWith(" ▸ ahora:"))
  expect(text[now + 1]!.endsWith("…")).toBe(true)
  expect(text[now + 2]!.startsWith(" ▸ luego:")).toBe(true)
  for (const line of text) expect(line.length).toBeLessThanOrEqual(38)
})

describe("cycle step per task (inferred)", () => {
  test("uncommitted changes: «código» is highlighted", () => {
    const all = lines("oddDirty")
    expect(cycleSegment(all, "código", "código")).toEqual({ text: "código", color: "accent", bold: true })
    expect(cycleSegment(all, "código", "commit").color).toBe("muted")
    expect(cycleSegment(all, "código", "checks").color).toBe("muted")
  })

  test("clean tree: «commit» is highlighted", () => {
    const all = lines("oddClean")
    expect(cycleSegment(all, "código", "commit")).toEqual({ text: "commit", color: "accent", bold: true })
    expect(cycleSegment(all, "código", "código").color).toBe("muted")
  })

  test("no git and no review: nothing is highlighted and the review says why", () => {
    const all = lines("oddNoGit")
    for (const word of ["código", "checks", "commit"]) expect(cycleSegment(all, "código", word).color).toBe("muted")
    expect(all.map(lineText)).toContain("   revisión: sin .git")
  })

  test("correction_required: «revisión ✗» and the «corregir» loop in red", () => {
    const all = lines("oddCorrection")
    const text = all.map(lineText)
    expect(text).toContain(" │    └───────────── revisión ✗ │")
    expect(cycleSegment(all, "revisión ✗", "revisión")).toEqual({ text: "revisión", color: "error", bold: true })
    expect(cycleSegment(all, "revisión ✗", "✗").color).toBe("error")
    expect(cycleSegment(all, "corregir", "│ corregir").color).toBe("error")
    expect(cycleSegment(all, "código", "código").color).toBe("muted")
  })

  test("review in progress: «revisión ◉» highlighted in accent", () => {
    const all = lines("oddReviewing")
    expect(all.map(lineText)).toContain(" │    └───────────── revisión ◉ │")
    expect(cycleSegment(all, "revisión ◉", "revisión")).toEqual({ text: "revisión", color: "accent", bold: true })
    expect(cycleSegment(all, "corregir", "│ corregir").color).toBe("muted")
  })

  test("approved review: «revisión ✓» and the step comes from git", () => {
    const all = lines("oddApproved")
    expect(all.map(lineText)).toContain(" │    └───────────── revisión ✓ │")
    expect(cycleSegment(all, "revisión ✓", "✓").color).toBe("success")
    expect(cycleSegment(all, "código", "commit").color).toBe("accent")
    expect(cycleSegment(all, "código", "checks").color).toBe("muted")
  })
})

test("pinned layout: the ODD example from the approved sketch", () => {
  expect(sidebarText(CASES.oddExample)).toBe(
    [
      " ◆ ODD · sample-app-skeleton  inferido",
      "",
      "   ✓ autorizar",
      "   ▼",
      "   ✓ explorar · clasificar",
      "   ▼",
      "   ✓ tareas  odd/tasks/sample-….md (9)",
      "   ▼",
      " ┌──────────────────────────────┐",
      " │ ◉ implementar · T7 de 9      │",
      " │                              │",
      " │  código ─▶ checks ─▶ commit  │",
      " │    ▲                   │     │",
      " │    │ corregir          ▼     │",
      " │    └───────────── revisión ✗ │",
      " └─┬────────────────────────────┘",
      "   ▼  ◀ estás aquí",
      "   ○ cerrar  (2 pendientes)",
      "",
      " ▸ ahora: T7 Installer (partial)",
      " ▸ revisión: correction_required",
      "   ✗ risk 4       ✗ resilience 3",
      "   ✓ readability  ◉ reliability",
      " ▸ luego: capturar la TUI con pyte y",
      "   revisar el borde de la caja activa…",
    ].join("\n"),
  )
})
