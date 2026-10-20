import { describe, expect, test } from "bun:test"
import type { OddDocSummary } from "../../src/sources/odd.ts"
import { renderFull } from "../../src/view/full.ts"
import { followOddSelection, reduceOddList, renderOddList } from "../../src/view/odd-list.ts"
import { lineText, lineWidth } from "../../src/view/text.ts"
import { full, segmentsWith, texts, view } from "./helpers.ts"
import { CASES } from "./snapshots.ts"

const f = (name: string, done: number, total: number, current?: string): OddDocSummary => ({
  name,
  file: `odd/tasks/${name}.md`,
  title: name,
  total,
  done,
  allDone: total > 0 && done === total,
  ...(current ? { current } : {}),
})

const FEATURES = [f("modo-oscuro-carta", 2, 5, "T3"), f("carta-alergenos", 0, 4, "T1"), f("pedidos-en-mesa", 4, 4)]

describe("ODD feature list", () => {
  test("header, one row per feature, the selected one with ▸ and the pinned one with «fijado»", () => {
    const text = texts(renderOddList({ features: FEATURES, selected: 1, pinned: "modo-oscuro-carta" }, 80))
    expect(text).toEqual([
      " Features ODD  3",
      "   modo-oscuro-carta  T3/5   fijado",
      " ▸ carta-alergenos    T1/4",
      "   pedidos-en-mesa    ✓ 4/4",
    ])
  })

  test("pinned as new: «nuevo» instead of «fijado», same place and color", () => {
    const lines = renderOddList({ features: FEATURES, selected: 1, pinned: "modo-oscuro-carta", pinnedNew: true }, 80)
    expect(texts(lines)[1]).toBe("   modo-oscuro-carta  T3/5   nuevo")
    expect(texts(lines).some((l) => l.includes("fijado"))).toBe(false)
    expect(segmentsWith(lines, "nuevo")[0]).toMatchObject({ color: "accent" })
    for (const width of [40, 60]) {
      for (const line of renderOddList({ features: FEATURES, selected: 0, pinned: "modo-oscuro-carta", pinnedNew: true }, width)) expect(lineWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test("colors: selected in accent and bold, done in green", () => {
    const lines = renderOddList({ features: FEATURES, selected: 0, pinned: "modo-oscuro-carta" }, 80)
    expect(segmentsWith(lines, "modo-oscuro-carta")[0]).toMatchObject({ color: "accent", bold: true })
    expect(segmentsWith(lines, "✓ 4/4")[0]).toMatchObject({ color: "success" })
    expect(segmentsWith(lines, "fijado")[0]).toMatchObject({ color: "accent", bold: true })
  })

  test("no features: nothing; out-of-range selection is clamped", () => {
    expect(renderOddList({ features: [], selected: 0 }, 80)).toEqual([])
    expect(texts(renderOddList({ features: FEATURES, selected: 9 }, 80))[3]).toStartWith(" ▸ pedidos-en-mesa")
  })

  test("long names: clipped, and no row exceeds the width", () => {
    const long = [f("una-feature-con-un-nombre-larguísimo-de-verdad-que-no-cabe", 1, 40, "T2"), ...FEATURES]
    for (const width of [40, 60, 100, 170]) {
      for (const line of renderOddList({ features: long, selected: 0, pinned: long[0]!.name }, width)) {
        expect(lineWidth(line), `@${width}: «${lineText(line)}»`).toBeLessThanOrEqual(width)
      }
    }
  })

  test("in the overview it goes on top, before the diagrams", () => {
    const text = texts(renderFullWithList())
    expect(text[2]).toBe(" Features ODD  3")
    expect(text.findIndex((l) => l.includes("◆ ODD"))).toBeGreaterThan(5)
    expect(full(CASES.both, 100).some((l) => l.includes("Features ODD"))).toBe(false)
  })
})

describe("list selection", () => {
  test("↑↓ move and stop at the ends", () => {
    expect(reduceOddList(0, "down", 3)).toBe(1)
    expect(reduceOddList(2, "down", 3)).toBe(2)
    expect(reduceOddList(0, "up", 3)).toBe(0)
    expect(reduceOddList(2, "up", 3)).toBe(1)
    expect(reduceOddList(7, "up", 3)).toBe(1)
    expect(reduceOddList(0, "down", 0)).toBe(0)
  })

  test("on reload the selection follows the selected name; if it disappears, the index is clamped", () => {
    const reordered = [FEATURES[2]!, FEATURES[0]!, FEATURES[1]!]
    expect(followOddSelection(1, FEATURES, reordered)).toBe(2)
    expect(followOddSelection(2, FEATURES, [FEATURES[0]!])).toBe(0)
    expect(followOddSelection(0, [], FEATURES)).toBe(0)
  })
})

function renderFullWithList() {
  return renderFull(view(CASES.both), 100, { oddList: { features: FEATURES, selected: 0 } })
}
