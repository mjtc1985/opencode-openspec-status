// The English UI. The rest of the suite runs in Spanish (see test/setup.ts); here
// the main screens are checked in English, including that every case still fits
// the sidebar and full-screen widths with the English strings.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SDD_PHASES, SIDEBAR_WIDTH } from "../../src/model.ts"
import { detectLocale, localeFrom, setLocale, t } from "../../src/i18n.ts"
import { renderFull } from "../../src/view/full.ts"
import { detailHelp, renderSddDetail } from "../../src/view/sdd-detail.ts"
import { renderSidebar } from "../../src/view/sidebar.ts"
import { lineText, lineWidth } from "../../src/view/text.ts"
import { twoChanges } from "./detail-fixtures.ts"
import { compact, full, sidebar, sidebarText, texts, view } from "./helpers.ts"
import { CASES, change, snapshot } from "./snapshots.ts"

beforeAll(() => setLocale("en"))
afterAll(() => setLocale("es"))

describe("locale detection", () => {
  test("OPENSPEC_STATUS_LANG first, then LC_ALL, LC_MESSAGES and LANG", () => {
    expect(detectLocale({ OPENSPEC_STATUS_LANG: "es", LANG: "en_US.UTF-8" })).toBe("es")
    expect(detectLocale({ LC_ALL: "es_ES.UTF-8", LANG: "en_US.UTF-8" })).toBe("es")
    expect(detectLocale({ LC_MESSAGES: "en_GB", LANG: "es_ES" })).toBe("en")
    expect(detectLocale({ LANG: "es_MX.UTF-8" })).toBe("es")
  })

  test("Spanish locales map to es, any other to en; C and POSIX are no choice", () => {
    expect(localeFrom("es-419")).toBe("es")
    expect(localeFrom("fr_FR.UTF-8")).toBe("en")
    expect(localeFrom("C")).toBeUndefined()
    expect(localeFrom("POSIX")).toBeUndefined()
    expect(localeFrom(undefined)).toBeUndefined()
    expect(localeFrom("en")).toBe("en")
  })

  test("t fills {placeholders}", () => {
    expect(t("sdd.nOfTotal", { n: 1, total: 6 })).toBe("1 of 6")
  })
})

describe("sidebar in English", () => {
  test("nothing active: the SDD chain and how to start", () => {
    expect(sidebarText(CASES.idle)).toBe(
      [
        " ◇ openspec-status",
        "",
        "   explore → propose → spec →",
        "   design → tasks → apply →",
        "   verify → archive",
        "",
        " nothing active",
        "   start an OpenSpec change (sdd-new",
        "   or openspec new change)",
        "   or an ODD feature in odd/tasks/",
      ].join("\n"),
    )
  })

  test("SDD in apply: box with progress, the per-task loop and what comes next", () => {
    const text = sidebar(CASES.sddApply)
    expect(text[0]).toBe(" ◆ SDD · add-price-cache")
    expect(text).toContain(" │ ◉ apply  6/16        │◀─┐")
    expect(text).toContain("   ▼  ◀ you are here       │")
    expect(text).toContain("   ○ verify ───────────────┘ fails")
    expect(text.some((l) => l.includes("⚠ changed"))).toBe(true)
    expect(text.at(-1)).toBe(" ▸ then: continue apply (10 left)")
    expect(compact(CASES.sddApply)).toBe("SDD · apply 6/16")
  })

  test("blocked SDD and several changes", () => {
    expect(compact(CASES.sddBlocked)).toBe("SDD ✗ blocked")
    expect(sidebar(CASES.sddBlocked)).toContain("   ○ spec  ▸ next")
    expect(sidebar(CASES.sddChoice)).toContain("   (1 of 2)")
  })

  test("ODD: inferred header, implement box with its cycle and the review lenses", () => {
    const text = sidebar(CASES.oddExample)
    expect(text[0]).toBe(" ◆ ODD · sample-app-skeleton  inferred")
    expect(text).toContain(" │ ◉ implement · T7 of 9        │")
    expect(text).toContain(" │  code ─▶ checks ─▶ commit    │")
    expect(text).toContain("   ○ close  (2 pending)")
    expect(text).toContain("   ✗ risk 4       ✗ resilience 3")
    expect(compact(CASES.oddExample)).toBe("ODD · T7/9 · rev ✗")
  })

  test("SDD read from the files (no gentle-ai): «(inferred)» in the header", () => {
    const text = sidebar(snapshot({ sdd: change({ source: "files" }) }))
    expect(text[0]).toBe(" ◆ SDD · add-price-cache (inferred)")
  })

  test("every case fits 36 and 38 columns", () => {
    for (const [name, s] of Object.entries(CASES)) {
      const v = view(s)
      for (const width of [36, SIDEBAR_WIDTH]) {
        for (const line of renderSidebar(v, width)) expect(lineWidth(line), `${name} @${width}: «${lineText(line)}»`).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe("full screen and SDD detail in English", () => {
  test("full screen: header, both columns and the legend", () => {
    const text = full(CASES.both, 100)
    expect(text[0]).toBe(" ◆ openspec-status · /home/ana/proyecto")
    expect(text.join("\n")).toContain("when each mark changes")
    expect(text.at(-1)).toBe(" esc: back")
    for (const [name, s] of Object.entries(CASES)) {
      for (const width of [60, 100]) {
        for (const line of renderFull(view(s), width)) expect(lineWidth(line), `${name} @${width}`).toBeLessThanOrEqual(width)
      }
    }
  })

  test("detail: header and key bar", () => {
    const lines = texts(renderSddDetail(twoChanges(), { changeIndex: 0, phase: "apply" }, 100, {}))
    expect(lines[0]).toBe(" openspec-status · SDD")
    expect(lines.at(-1)).toContain("esc back")
    expect(detailHelp()).toContainEqual(["enter", "pin"])
    for (const phase of SDD_PHASES) {
      for (const line of renderSddDetail(twoChanges(), { changeIndex: 0, phase }, 60, {})) expect(lineWidth(line)).toBeLessThanOrEqual(60)
    }
  })
})
