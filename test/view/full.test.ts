import { expect, test } from "bun:test"
import { clock } from "../../src/view/parts.ts"
import { full } from "./helpers.ts"
import { CASES, NOW } from "./snapshots.ts"

test("width 100: ODD and SDD side by side", () => {
  const text = full(CASES.both, 100)
  expect(text[0]).toBe(" ◆ openspec-status · /home/ana/proyecto")
  const head = text.find((l) => l.includes("◆ ODD"))!
  expect(head).toContain("◆ SDD · add-price-cache")
  expect(head.indexOf("◆ SDD")).toBeGreaterThan(head.indexOf("inferido"))
  expect(text.at(-1)).toBe(" esc: volver")
})

test("width 60: stacked, ODD above SDD", () => {
  const text = full(CASES.both, 60)
  const odd = text.findIndex((l) => l.startsWith(" ◆ ODD"))
  const sdd = text.findIndex((l) => l.startsWith(" ◆ SDD"))
  expect(odd).toBeGreaterThan(0)
  expect(sdd).toBeGreaterThan(odd)
  expect(text.filter((l) => l.includes("◆ SDD")).length).toBe(1)
})

test("details the sidebar clips: every task, file, lenses and errors", () => {
  const text = full(CASES.both, 60)
  expect(text).toContain("   fichero: odd/tasks/sample-app-skeleton.md")
  for (const task of ["   ✓ T1 Scaffold", "   ○ T8 Reduce bash friction while exploring", "   ◉ T7 Installer (partial)"]) expect(text).toContain(task)
  expect(text).toContain("   ✗ risk · 4 hallazgos")
  expect(text).toContain("   ◉ reliability · en curso")
  expect(text).toContain(" ▸ luego: capturar la TUI con pyte y revisar el borde de la")
  expect(text).toContain("   exit 1")
})

test("drift with files and HH:MM times", () => {
  const text = full(CASES.sddApply, 100).join("\n")
  expect(text).toContain(`openspec/changes/add-price-cache/specs/cache/spec.md (${clock(NOW - 5 * 60_000)}) cambió tras`)
  expect(text).toContain(`openspec/changes/add-price-cache/tasks.md (${clock(NOW - 30 * 60_000)})`)
  expect(clock(NOW)).toMatch(/^\d\d:\d\d$/)
})

test("every blocking reason, without «… and N more»", () => {
  const text = full(CASES.sddBlocked, 60)
  expect(text).toContain(" ✗ specs vacío")
  expect(text).toContain(" ✗ design vacío")
  expect(text.some((l) => l.includes("más"))).toBe(false)
})

test("nothing active in full screen: the SDD chain on one line", () => {
  const text = full(CASES.idle, 100)
  expect(text).toContain("   explore → propose → spec → design → tasks → apply → verify → archive")
  expect(text.at(-1)).toBe(" esc: volver")
})
