import { expect, test } from "bun:test"
import { buildView, formatAge } from "../../src/view/flow-view.ts"
import { renderSidebar } from "../../src/view/sidebar.ts"
import { sidebar, sidebarText, view } from "./helpers.ts"
import { CASES, NOW } from "./snapshots.ts"

test("pinned layout: nothing active, everything muted", () => {
  expect(sidebarText(CASES.idle)).toBe(
    [
      " ◇ openspec-status",
      "",
      "   explore → propose → spec →",
      "   design → tasks → apply →",
      "   verify → archive",
      "",
      " nada activo",
      "   empieza un cambio OpenSpec (sdd-new",
      "   u openspec new change)",
      "   o una feature ODD en odd/tasks/",
    ].join("\n"),
  )
  expect(renderSidebar(view(CASES.idle)).flat().every((s) => s.color === "muted")).toBe(true)
})

test("failing source: stale line at the end with its age", () => {
  const text = sidebar(CASES.idleStale)
  expect(text.slice(-2)).toEqual([" ⚠ desactualizado · sdd-status falló", "   hace 40 s"])
  expect(buildView(CASES.idleStale, NOW).stale).toEqual([{ source: "sdd", label: "sdd-status", ageMs: 40_000, error: "timeout tras 5 s" }])
})

test("ODD and SDD together: ODD first, then SDD, stale notes last", () => {
  const text = sidebar(CASES.both)
  const odd = text.indexOf(" ◆ ODD · sample-app-skeleton  inferido")
  const sdd = text.indexOf(" ◆ SDD · add-price-cache")
  expect(odd).toBe(0)
  expect(sdd).toBeGreaterThan(odd)
  expect(text.some((l) => l.startsWith(" ── revisión"))).toBe(false)
  expect(text.slice(-2)).toEqual([" ⚠ desactualizado · review status", "   falló hace 2 min"])
})

test("formatAge: seconds, minutes, hours and days", () => {
  expect(formatAge(40_000)).toBe("40 s")
  expect(formatAge(125_000)).toBe("2 min")
  expect(formatAge(3 * 3_600_000)).toBe("3 h")
  expect(formatAge(72 * 3_600_000)).toBe("3 d")
})
