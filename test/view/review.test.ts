import { expect, test } from "bun:test"
import { renderSidebar } from "../../src/view/sidebar.ts"
import { lineText } from "../../src/view/text.ts"
import { sidebar, view } from "./helpers.ts"
import { CASES } from "./snapshots.ts"

/** Lines from the review block header on. */
const block = (text: string[]) => text.slice(text.findIndex((l) => l.startsWith(" ── revisión ")))

test("own block after SDD: header, lenses and a stop with a manual action, no commands", () => {
  const text = block(sidebar(CASES.reviewStop))
  expect(text[0]).toBe(" ── revisión " + "─".repeat(25))
  expect(text).toContain(" ▸ estado: reviewing")
  expect(text).toContain("   ✓ risk  ◉ resilience")
  expect(text).toContain(" ▸ parada: los artefactos capturados")
  expect(text).toContain("   → acción manual")
  expect(text.join("\n")).not.toMatch(/gentle-ai|review start|--/)
})

test("stop without a description: the reasonCode is shown", () => {
  expect(sidebar(CASES.reviewStopNoDescription)).toContain(" ▸ parada: consent_required")
})

test("review of another code state: muted notice and how to continue", () => {
  const all = renderSidebar(view(CASES.reviewOther))
  const text = all.map(lineText)
  expect(text).toContain("   revisión de otro estado del código")
  expect(text).toContain(" ▸ corrige los hallazgos y vuelve a")
  expect(text).toContain("   ✗ risk 1")
  expect(text.some((l) => l.includes("parada"))).toBe(false)
  const other = all.find((l) => lineText(l).includes("otro estado"))!
  expect(other.every((s) => s.color === "muted")).toBe(true)
})

test("no readable lenses: the grid is hidden", () => {
  const text = block(sidebar(CASES.reviewNoLenses))
  expect(text).toEqual([" ── revisión " + "─".repeat(25), " ▸ estado: approved"])
})

test("review unavailable: a single muted line, no header", () => {
  const text = sidebar(CASES.reviewUnavailable)
  expect(text.at(-1)).toBe("   revisión: sin .git")
  expect(text.some((l) => l.startsWith(" ── revisión"))).toBe(false)
})

test("incoherent review: notice with the reasons", () => {
  const text = block(sidebar(CASES.reviewIncoherent))
  expect(text).toContain(" ⚠ revisión incoherente:")
  expect(text).toContain(" · dos entradas activas para el mismo")
})
