import { expect, test } from "bun:test"
import { lineText, lineWidth, seg, truncate, truncateLine, wrap, wrapWithPrefix } from "../../src/view/text.ts"

test("lineText and lineWidth count the text of every segment", () => {
  const line = [seg(" ▸ ", "accent"), seg("ahora", "text")]
  expect(lineText(line)).toBe(" ▸ ahora")
  expect(lineWidth(line)).toBe(8)
})

test("truncate cuts with «…» without exceeding the width", () => {
  expect(truncate("add-price-cache", 20)).toBe("add-price-cache")
  expect(truncate("add-price-cache", 8)).toBe("add-pri…")
  expect(truncate("abc", 1)).toBe("…")
  expect(truncate("abc", 0)).toBe("")
})

test("wrap breaks on words and splits the ones that do not fit", () => {
  expect(wrap("capturar la TUI con pyte", 12)).toEqual(["capturar la", "TUI con pyte"])
  expect(wrap("supercalifragilístico", 8)).toEqual(["supercal", "ifragilí", "stico"])
  expect(wrap("   ", 10)).toEqual([])
})

test("truncateLine clips segments keeping their colors", () => {
  const line = truncateLine([seg("abc", "accent"), seg("defgh", "text")], 6)
  expect(lineText(line)).toBe("abcde…")
  expect(line[0]!.color).toBe("accent")
})

test("wrapWithPrefix indents continuations and caps the line count with «…»", () => {
  const lines = wrapWithPrefix([seg(" ▸ luego: ", "muted")], "uno dos tres cuatro cinco seis siete ocho", "text", 20, { maxLines: 2 })
  expect(lines.map(lineText)).toEqual([" ▸ luego: uno dos", "   tres cuatro cinc…"])
  for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(20)
})
