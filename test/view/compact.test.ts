import { expect, test } from "bun:test"
import { compactLabel } from "../../src/view/compact.ts"
import { compact, view } from "./helpers.ts"
import { CASES } from "./snapshots.ts"

test("SDD: current phase ▸ next", () => {
  expect(compact(CASES.sddSpecs)).toBe("SDD · spec ▸ design")
  expect(compact(CASES.sddArchived)).toBe("SDD · archive")
})

test("SDD in apply: task progress", () => {
  expect(compact(CASES.sddApply)).toBe("SDD · apply 6/16")
})

test("SDD blocked, incoherent or in an unknown format", () => {
  expect(compact(CASES.sddBlocked)).toBe("SDD ✗ bloqueado")
  expect(compact(CASES.sddIncoherent)).toBe("SDD ⚠ incoherente")
  expect(compact(CASES.sddUnsupported)).toBe("SDD ⚠ formato desconocido")
})

test("ODD: current task / total, and the review mark only when there is one", () => {
  expect(compact(CASES.oddExample)).toBe("ODD · T7/9 · rev ✗")
  expect(compact(CASES.oddReviewing)).toBe("ODD · T3/4 · rev ◉")
  expect(compact(CASES.oddApproved)).toBe("ODD · T3/4 · rev ✓")
  expect(compact(CASES.oddDirty)).toBe("ODD · T3/4")
  expect(compact(CASES.oddAllDone)).toBe("ODD · cerrar")
})

test("ODD and SDD together: ODD first; ⚠ if any source is stale", () => {
  expect(compact(CASES.both)).toBe("ODD · T7/9 · rev ✗ · SDD · apply 6/16 ⚠")
})

test("without ODD, the review goes after SDD", () => {
  expect(compact(CASES.reviewOther)).toBe("SDD · apply 6/16 · rev ✗")
})

test("nothing active: no indicator, even with stale sources", () => {
  expect(compact(CASES.idle)).toBeUndefined()
  expect(compact(CASES.idleStale)).toBeUndefined()
})

test("colors: accent on what is active, marks in their color and muted separators", () => {
  const line = compactLabel(view(CASES.both))!
  expect(line.find((s) => s.text === "T7/9")!.color).toBe("accent")
  expect(line.find((s) => s.text === "✗")!.color).toBe("error")
  expect(line.find((s) => s.text === " · ")!.color).toBe("muted")
  expect(line.find((s) => s.text === "apply 6/16")!.color).toBe("accent")
  expect(line.at(-1)).toEqual({ text: " ⚠", color: "warning" })
})
