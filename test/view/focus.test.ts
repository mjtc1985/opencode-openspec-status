import { describe, expect, test } from "bun:test"
import type { OddFeature, SddChange, Snapshot } from "../../src/model.ts"
import { alsoText } from "../../src/view/focus.ts"
import { renderSidebar } from "../../src/view/sidebar.ts"
import { lineWidth } from "../../src/view/text.ts"
import { compact, full, texts, view } from "./helpers.ts"
import { CASES, NOW, change, feature, oddDemo, oddExample, oddPinned, sddExample, snapshot } from "./snapshots.ts"

const has = (lines: string[], needle: string) => lines.some((l) => l.includes(needle))
// 36: the real usable width of the sidebar (see tui.tsx).
const sidebar = (s: Snapshot, width = 36) => texts(renderSidebar(view(s), width))

describe("focus by pin: sidebar", () => {
  test("SDD pinned: no ODD section, «también: ODD …» at the end of SDD and the review in its block", () => {
    const text = sidebar(CASES.focusSdd)
    expect(text[0]).toBe(" ◆ SDD · ticket-digital")
    expect(text[1]).toBe("   (1 de 6 · fijado)")
    expect(has(text, "◆ ODD")).toBe(false)
    expect(has(text, "implementar")).toBe(false)
    const also = text.indexOf("   también: ODD sample-app-skeleton")
    expect(also).toBeGreaterThan(text.indexOf(" ▸ luego: seguir apply (10 pend.)"))
    expect(text[also + 1]).toBe("   (T7/9)")
    expect(text.indexOf(" ── revisión ───────────────────────")).toBeGreaterThan(also)
  })

  test("a single pinned SDD change: «(fijado)» in the header, or on its own line if it does not fit", () => {
    expect(sidebar(CASES.focusSddSingle)[0]).toBe(" ◆ SDD · add-price-cache (fijado)")
    const long = sidebar(CASES.focusSddSingleLong)
    expect(long[0]).toBe(" ◆ SDD · un-cambio-con-nombre-muy-l…")
    expect(long[1]).toBe("   (fijado)")
  })

  test("SDD pinned without ODD: no «también» line", () => {
    expect(has(sidebar(CASES.focusSddAlone), "también")).toBe(false)
  })

  test("ODD pinned: no SDD section, «también: SDD …» with its phase and how many changes; «inferido» stays", () => {
    const text = sidebar(CASES.focusOdd)
    expect(text[0]).toBe(" ◆ ODD · modo-oscuro-carta  inferido")
    expect(text[1]).toBe("   (fijado)")
    expect(has(text, "◆ SDD")).toBe(false)
    expect(has(text, "○ verify")).toBe(false)
    expect(text.slice(-2)).toEqual(["   también: SDD ticket-digital", "   (apply 6/16 ⚠) · 6 cambios"])
    // The review stays inside ODD, without its own block.
    expect(has(text, " ▸ revisión: correction_required")).toBe(true)
    expect(text.some((l) => l.startsWith(" ── revisión"))).toBe(false)
  })

  test("ODD pinned with a single SDD change: no «· N cambios»", () => {
    expect(sidebar(CASES.focusOddSingleSdd).slice(-2)).toEqual(["   también: SDD add-price-cache", "   (spec ▸ design)"])
  })

  test("ODD pinned with no pending tasks: shown anyway, at «cerrar»", () => {
    const text = sidebar(CASES.focusOddAllDone)
    expect(text[1]).toBe("   (fijado)")
    expect(has(text, "◉ cerrar")).toBe(true)
  })

  test("ODD pinned with incoherent SDD or no SDD", () => {
    expect(sidebar(CASES.focusOddIncoherent).slice(-1)).toEqual(["   también: SDD ⚠ incoherente"])
    expect(has(sidebar(CASES.focusOddAlone), "también")).toBe(false)
  })

  test("pinned as new: «nuevo» instead of «fijado» in the header, at 36 and 38 columns", () => {
    for (const width of [36, 38]) {
      const sdd = sidebar(CASES.focusSddNew, width)
      expect(sdd[0]).toStartWith(" ◆ SDD · prueba-nueva")
      expect(sdd.slice(0, 2).join(" ")).toContain("(1 de 7 · nuevo)")
      expect(has(sdd, "fijado")).toBe(false)
      expect(has(sdd, "◆ ODD")).toBe(false)
      expect(sidebar(CASES.focusSddNewSingle, width)[0]).toBe(" ◆ SDD · add-price-cache (nuevo)")
      const long = sidebar(CASES.focusSddNewLong, width)
      expect(long[1]).toBe("   (1 de 7 · nuevo)")
      const odd = sidebar(CASES.focusOddNew, width)
      // Like «fijado»: if the name does not fit next to «nuevo · inferido», the reason moves to its own line.
      expect(odd[0]).toMatch(/^ ◆ ODD · otra-feature +inferido$/)
      expect(odd[1]).toBe("   (nuevo)")
      expect(has(odd, "fijado")).toBe(false)
      expect(has(odd, "◆ SDD")).toBe(false)
      const oddLong = sidebar(CASES.focusOddNewLong, width)
      expect(oddLong[1]).toBe("   (nuevo)")
      for (const c of [CASES.focusSddNew, CASES.focusSddNewSingle, CASES.focusSddNewLong, CASES.focusOddNew, CASES.focusOddNewLong]) {
        for (const line of renderSidebar(view(c), width)) expect(lineWidth(line)).toBeLessThanOrEqual(width)
      }
    }
    expect(view(CASES.focusOddNew)).toMatchObject({ focus: "odd", focusReason: "pinned" })
  })

  test("nothing pinned: as usual, ODD on top and SDD below, no «también»", () => {
    const text = sidebar(CASES.both)
    expect(text.findIndex((l) => l.startsWith(" ◆ ODD"))).toBeLessThan(text.findIndex((l) => l.startsWith(" ◆ SDD")))
    expect(has(text, "también")).toBe(false)
    expect(has(text, "fijado")).toBe(false)
    expect(view(CASES.both).focus).toBeUndefined()
  })

  test("if both sources carry pinned (while the pin switches), SDD wins until the next read", () => {
    const both: Snapshot = snapshot({ sdd: change({ ...sddExample, pinned: true }), odd: feature({ ...oddExample, pinned: true }) })
    expect(view(both).focus).toBe("sdd")
  })
})

describe("focus by pin: indicator", () => {
  test("SDD pinned: only SDD (and the review)", () => {
    expect(compact(CASES.focusSdd)).toBe("SDD · apply 6/16 · rev ✗")
  })

  test("ODD pinned: only ODD (and the review)", () => {
    expect(compact(CASES.focusOdd)).toBe("ODD · T7/9 · rev ✗")
    expect(compact(CASES.focusOddAllDone)).toBe("ODD · cerrar")
  })

  test("with a stale source, ⚠ at the end", () => {
    expect(compact(CASES.focusStale)).toBe("ODD · T7/9 ⚠")
  })

  test("nothing pinned, no changes", () => {
    expect(compact(CASES.both)).toBe("ODD · T7/9 · rev ✗ · SDD · apply 6/16 ⚠")
  })
})

describe("focus by pin: full screen", () => {
  test("wide: a single column with the pinned one, «fijado · inferido» in the header and «también» below", () => {
    const text = full(CASES.focusOdd, 100)
    const head = text.find((l) => l.includes("◆ ODD"))!
    expect(head.endsWith("fijado · inferido")).toBe(true)
    expect(has(text, "◆ SDD")).toBe(false)
    expect(has(text, "   también: SDD ticket-digital (apply 6/16 ⚠) · 6 cambios")).toBe(true)
  })

  test("SDD pinned: no ODD column", () => {
    const text = full(CASES.focusSdd, 170)
    expect(has(text, "◆ ODD")).toBe(false)
    expect(has(text, "◆ SDD · ticket-digital (1 de 6 · fijado)")).toBe(true)
    expect(has(text, "también: ODD sample-app-skeleton (T7/9)")).toBe(true)
  })
})

test("alsoText: nothing when not pinned", () => {
  expect(alsoText(view(CASES.both))).toBeUndefined()
})

describe("automatic focus without a pin: by branch or newest", () => {
  const focusOf = (s: Snapshot) => {
    const v = view(s)
    return v.focus ? { focus: v.focus, reason: v.focusReason } : undefined
  }
  const both = (sdd: Partial<SddChange>, odd: Partial<OddFeature>) => snapshot({ sdd: change({ ...sddExample, ...sdd }), odd: feature({ ...oddDemo, ...odd }) })
  const byName = (length: number) => ({ by: "name" as const, length })

  test("branch → SDD: only SDD with «(1 de 6 · rama)» and «también: ODD …», even if ODD is newer", () => {
    expect(focusOf(CASES.autoSddBranch)).toEqual({ focus: "sdd", reason: "branch" })
    const text = sidebar(CASES.autoSddBranch)
    expect(text[0]).toBe(" ◆ SDD · fidelizacion-puntos")
    expect(text[1]).toBe("   (1 de 6 · rama)")
    expect(has(text, "◆ ODD")).toBe(false)
    const also = text.indexOf("   también: ODD modo-oscuro-carta")
    expect(also).toBeGreaterThan(0)
    expect(text[also + 1]).toBe("   (T7/9)")
    expect(text.indexOf(" ── revisión ───────────────────────")).toBeGreaterThan(also)
  })

  test("branch → ODD: only ODD, «inferido» stays and «(rama)» on its line; «también: SDD …» at the end", () => {
    expect(focusOf(CASES.autoOddBranch)).toEqual({ focus: "odd", reason: "branch" })
    const text = sidebar(CASES.autoOddBranch)
    expect(text[0]).toBe(" ◆ ODD · modo-oscuro-carta  inferido")
    expect(text[1]).toBe("   (rama)")
    expect(has(text, "◆ SDD")).toBe(false)
    expect(text.slice(-2)).toEqual(["   también: SDD add-price-cache", "   (apply 6/16 ⚠)"])
  })

  test("ODD with a long name: «(rama)» moves to its line and «inferido» is not lost", () => {
    const text = sidebar(CASES.autoOddLong)
    expect(text[0]!.endsWith("inferido")).toBe(true)
    expect(text[1]).toBe("   (rama)")
  })

  test("both match the branch: the more specific; on a tie, SDD", () => {
    expect(focusOf(both({ branchMatch: byName(11) }, { branchMatch: byName(11) }))).toEqual({ focus: "sdd", reason: "branch" })
    expect(focusOf(both({ branchMatch: byName(6) }, { branchMatch: byName(11) }))).toEqual({ focus: "odd", reason: "branch" })
    expect(focusOf(both({ branchMatch: byName(12) }, { branchMatch: byName(11) }))).toEqual({ focus: "sdd", reason: "branch" })
    // The work item is more specific than any name.
    expect(focusOf(both({ branchMatch: { by: "workItem", length: 3 } }, { branchMatch: byName(30) }))).toEqual({ focus: "sdd", reason: "branch" })
    // The branch beats the date.
    expect(focusOf(both({ branchMatch: byName(3), updatedAt: NOW - 3_600_000 }, { updatedAt: NOW }))).toEqual({ focus: "sdd", reason: "branch" })
  })

  test("no branch: the newest; a single SDD change carries «(reciente)», several «(1 de 6 · reciente)»", () => {
    expect(focusOf(CASES.autoSddRecent)).toEqual({ focus: "sdd", reason: "recent" })
    expect(sidebar(CASES.autoSddRecent)[0]).toBe(" ◆ SDD · add-price-cache (reciente)")
    const choice = sidebar(CASES.autoSddRecentChoice)
    expect(choice[0]).toBe(" ◆ SDD · ticket-digital")
    expect(choice[1]).toBe("   (1 de 6 · reciente)")
    expect(has(choice, "también: ODD modo-oscuro-carta")).toBe(true)
  })

  test("ODD newer: only ODD with «(reciente)» and «también: SDD … · 6 cambios»", () => {
    expect(focusOf(CASES.autoOddRecent)).toEqual({ focus: "odd", reason: "recent" })
    const text = sidebar(CASES.autoOddRecent)
    expect(text[0]).toBe(" ◆ ODD · modo-oscuro-carta  inferido")
    expect(text[1]).toBe("   (reciente)")
    expect(text.slice(-2)).toEqual(["   también: SDD ticket-digital", "   (apply 6/16 ⚠) · 6 cambios"])
  })

  test("same date: SDD", () => {
    expect(focusOf(both({ updatedAt: NOW }, { updatedAt: NOW }))).toEqual({ focus: "sdd", reason: "recent" })
  })

  test("a date missing: everything is shown, as before, without guessing", () => {
    expect(focusOf(CASES.autoNoDate)).toBeUndefined()
    expect(focusOf(both({}, { updatedAt: NOW }))).toBeUndefined()
    expect(focusOf(both({ updatedAt: 0 }, { updatedAt: NOW }))).toBeUndefined()
    const text = sidebar(CASES.autoNoDate)
    expect(text.findIndex((l) => l.startsWith(" ◆ ODD"))).toBeLessThan(text.findIndex((l) => l.startsWith(" ◆ SDD")))
    expect(has(text, "también")).toBe(false)
    expect(has(text, "reciente")).toBe(false)
  })

  test("the pin beats automatic focus", () => {
    const oddWins = snapshot({ sdd: change({ ...sddExample, branchMatch: byName(20), updatedAt: NOW }), odd: oddPinned })
    expect(focusOf(oddWins)).toEqual({ focus: "odd", reason: "pinned" })
    expect(sidebar(oddWins)[1]).toBe("   (fijado)")
    const sddWins = snapshot({ sdd: change({ ...sddExample, pinned: true }), odd: feature({ ...oddDemo, branchMatch: byName(17), updatedAt: NOW }) })
    expect(focusOf(sddWins)).toEqual({ focus: "sdd", reason: "pinned" })
    expect(sidebar(sddWins)[0]).toBe(" ◆ SDD · add-price-cache (fijado)")
  })

  test("a single methodology: no focus and no mark, as before", () => {
    const sddOnly = snapshot({ sdd: change({ ...sddExample, branchMatch: byName(15), updatedAt: NOW }) })
    expect(focusOf(sddOnly)).toBeUndefined()
    expect(sidebar(sddOnly)[0]).toBe(" ◆ SDD · add-price-cache")
    const oddOnly = snapshot({ odd: feature({ ...oddDemo, branchMatch: byName(17), updatedAt: NOW }) })
    expect(focusOf(oddOnly)).toBeUndefined()
    expect(sidebar(oddOnly)[0]).toBe(" ◆ ODD · modo-oscuro-carta  inferido")
    expect(sidebar(oddOnly)[1]).toBe("")
    // Incoherent SDD is not a change: both are shown so the warning is not hidden.
    const incoherent = snapshot({ sdd: { kind: "incoherent", reasons: ["falta changeName"] }, odd: feature({ ...oddDemo, branchMatch: byName(17) }) })
    expect(focusOf(incoherent)).toBeUndefined()
  })

  test("indicator: follows the focused one", () => {
    expect(compact(CASES.autoSddBranch)).toBe("SDD · apply 6/16 · rev ✗")
    expect(compact(CASES.autoOddBranch)).toBe("ODD · T7/9 · rev ✗")
    expect(compact(CASES.autoOddRecent)).toBe("ODD · T7/9")
    expect(compact(CASES.autoNoDate)).toBe("ODD · T7/9 · SDD · apply 6/16")
  })

  test("full screen: shows everything, without a focus mark (pinning happens there)", () => {
    for (const s of [CASES.autoSddBranch, CASES.autoOddRecent]) {
      const text = full(s, 100)
      expect(has(text, "◆ ODD")).toBe(true)
      expect(has(text, "◆ SDD")).toBe(true)
      expect(has(text, "también")).toBe(false)
      expect(has(text, "reciente")).toBe(false)
    }
    expect(has(full(CASES.autoOddBranch, 100), "rama · inferido")).toBe(false)
  })

  test("36 and 38 columns: nothing overflows", () => {
    for (const s of [CASES.autoSddBranch, CASES.autoOddBranch, CASES.autoSddRecent, CASES.autoSddRecentChoice, CASES.autoOddRecent, CASES.autoOddLong]) {
      for (const width of [36, 38]) {
        for (const line of renderSidebar(view(s), width)) expect(lineWidth(line)).toBeLessThanOrEqual(width)
      }
    }
    // At 38 «reciente · inferido» does not fit next to the name either: it stays on its line, like «fijado».
    expect(texts(renderSidebar(view(CASES.autoOddRecent), 38))[1]).toBe("   (reciente)")
  })
})
