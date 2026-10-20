// Two-column characters (emoji, CJK) and zero-width ones (combining marks, ZWJ,
// variation selectors): width is measured in terminal columns.
import { describe, expect, test } from "bun:test"
import { SIDEBAR_WIDTH } from "../../src/model.ts"
import { shortenPath } from "../../src/view/odd.ts"
import { displayWidth, lineText, lineWidth, padTo, seg, sliceToWidth, truncate, truncateLine, wrap } from "../../src/view/text.ts"
import { sidebar, full } from "./helpers.ts"
import { feature, snapshot, tasks } from "./snapshots.ts"

describe("displayWidth", () => {
  test("ASCII and the view's symbols take one column", () => {
    expect(displayWidth("apply 4/15")).toBe(10)
    expect(displayWidth("┌─┐ ●◉○✓✗▸▼◀ ⚠ ◆ ▶")).toBe(18)
  })

  test("emoji with emoji presentation and CJK take two", () => {
    expect(displayWidth("✅ hecho ⏳")).toBe(11)
    expect(displayWidth("❌")).toBe(2)
    expect(displayWidth("設計書")).toBe(6)
    expect(displayWidth("ｆｕｌｌ")).toBe(8)
    expect(displayWidth("한국어")).toBe(6)
  })

  test("a text symbol with VS16 becomes two; ZWJ sequences and flags are a single emoji", () => {
    expect(displayWidth("⚠")).toBe(1)
    expect(displayWidth("⚠️")).toBe(2)
    expect(displayWidth("👨‍👩‍👧")).toBe(2)
    expect(displayWidth("🇪🇸")).toBe(2)
  })

  test("lone combining marks and ZWJ take none", () => {
    expect(displayWidth("é")).toBe(1)
    expect(displayWidth("a‍b")).toBe(2)
  })
})

describe("clipping and wrapping with wide characters", () => {
  test("sliceToWidth does not split a two-column character", () => {
    expect(sliceToWidth("日本語", 3)).toBe("日")
    expect(sliceToWidth("a👨‍👩‍👧b", 3)).toBe("a👨‍👩‍👧")
  })

  test("truncate and truncateLine respect columns", () => {
    const t = truncate("日本語のテキスト", 7)
    expect(t).toBe("日本語…")
    expect(displayWidth(t)).toBeLessThanOrEqual(7)
    const line = truncateLine([seg("✅ ", "success"), seg("hecho ⏳ pendiente", "text")], 10)
    expect(lineWidth(line)).toBeLessThanOrEqual(10)
    expect(lineText(line).endsWith("…")).toBe(true)
  })

  test("wrap measures in columns and splits wide words without overflowing", () => {
    for (const l of wrap("✅ T1 hecho ⏳ T2 en curso 設計書をレビューする", 10)) expect(displayWidth(l)).toBeLessThanOrEqual(10)
    expect(wrap("日本語テキスト", 4)).toEqual(["日本", "語テ", "キス", "ト"])
  })

  test("padTo pads to the column, not to the length", () => {
    expect(lineWidth(padTo([seg("⏳ ok", "text")], 8))).toBe(8)
  })

  test("shortenPath with a CJK name", () => {
    const p = shortenPath("odd/tasks/機能のリファクタリング.md", 22)
    expect(displayWidth(p)).toBeLessThanOrEqual(22)
    expect(p.startsWith("odd/tasks/")).toBe(true)
    expect(p.endsWith("….md")).toBe(true)
  })
})

describe("sidebar with wide text from the ODD document", () => {
  const odd = feature({
    title: "Feature: 検索キャッシュ ✨ precios",
    file: "odd/tasks/検索キャッシュ.md",
    tasks: [
      { id: "T1", title: "✅ esqueleto hecho", status: "done" },
      { id: "T2", title: "⏳ caché de 価格 con TTL y ❌ fallos contados", status: "active" },
      ...tasks("tt").map((t, i) => ({ ...t, id: `T${i + 3}` })),
    ],
    nextStep: "✅ hecho ⏳ esperando revisión; luego 設計書 y ❌ quitar el flag antiguo del todo",
  })
  const s = snapshot({ odd: { ...odd, current: odd.tasks[1] } })

  test("no line exceeds 38 real columns", () => {
    const lines = sidebar(s)
    for (const l of lines) expect(displayWidth(l), `«${l}»`).toBeLessThanOrEqual(SIDEBAR_WIDTH)
    const text = lines.join("\n")
    expect(text).toContain("検索")
    expect(text).toContain("▸ ahora: T2 ⏳")
    expect(text).toContain("▸ luego: ✅ hecho ⏳")
  })

  test("the full screen does not overflow either", () => {
    for (const width of [60, 80, 120]) for (const l of full(s, width)) expect(displayWidth(l), `@${width} «${l}»`).toBeLessThanOrEqual(width)
  })
})
