import { describe, expect, test } from "bun:test"
import type { SddPhaseId } from "../../src/model.ts"
import { clampDetailState, initialDetailState, reduceDetail, type DetailKey, type DetailState, type PanelScroll } from "../../src/view/detail-state.ts"

const changes = (...current: SddPhaseId[]) => current.map((c) => ({ status: { current: c } }))
const LIST = changes("apply", "spec", "verify")

const press = (keys: DetailKey[], list = LIST) => keys.reduce((s, k) => reduceDetail(s, k, list), initialDetailState(list))

/** 30-line panel in a 10-line window: max 20, page 9, initial 6 (the current task). */
const PANEL = (s: DetailState): PanelScroll => ({ scroll: Math.min(s.scroll ?? 6, 20), max: 20, page: 9 })
const scrollBy = (keys: DetailKey[], from: DetailState = initialDetailState(LIST)) => keys.reduce((s, k) => reduceDetail(s, k, LIST, PANEL(s)), from)

describe("initial state", () => {
  test("first change at its current phase, without its own scroll", () => {
    expect(initialDetailState(LIST)).toEqual({ changeIndex: 0, phase: "apply" })
  })

  test("no changes: explore", () => {
    expect(initialDetailState([])).toEqual({ changeIndex: 0, phase: "explore" })
  })
})

describe("↑↓ between changes", () => {
  test("the next one goes to the new change's current phase", () => {
    expect(press(["nextChange"])).toEqual({ changeIndex: 1, phase: "spec" })
    expect(press(["nextChange", "nextChange"])).toEqual({ changeIndex: 2, phase: "verify" })
    expect(press(["nextChange", "nextChange", "prevChange"])).toEqual({ changeIndex: 1, phase: "spec" })
  })

  test("stops at top and bottom without touching the chosen phase", () => {
    expect(press(["left", "prevChange"])).toEqual({ changeIndex: 0, phase: "tasks" })
    expect(press(["nextChange", "nextChange", "right", "nextChange"])).toEqual({ changeIndex: 2, phase: "archive" })
  })

  test("with no changes it does not move", () => {
    expect(press(["nextChange", "prevChange"], [])).toEqual({ changeIndex: 0, phase: "explore" })
  })

  test("switching change clears the scroll", () => {
    const scrolled = scrollBy(["pageDown"])
    expect(scrolled.scroll).toBe(15)
    expect(reduceDetail(scrolled, "nextChange", LIST)).toEqual({ changeIndex: 1, phase: "spec" })
  })
})

describe("←→ between phases", () => {
  test("moves forward and back with stops", () => {
    expect(press(["right"])).toEqual({ changeIndex: 0, phase: "verify" })
    expect(press(["right", "right", "right"])).toEqual({ changeIndex: 0, phase: "archive" })
    expect(press(["left", "left", "left", "left", "left", "left", "left"])).toEqual({ changeIndex: 0, phase: "explore" })
  })

  test("home and end", () => {
    expect(press(["home"])).toEqual({ changeIndex: 0, phase: "explore" })
    expect(press(["end"])).toEqual({ changeIndex: 0, phase: "archive" })
    expect(press(["end", "home", "right"])).toEqual({ changeIndex: 0, phase: "propose" })
  })

  test("switching phase clears the scroll; without moving, it is kept", () => {
    const scrolled = scrollBy(["pageDown"])
    expect(scrolled).toEqual({ changeIndex: 0, phase: "apply", scroll: 15 })
    expect(reduceDetail(scrolled, "left", LIST)).toEqual({ changeIndex: 0, phase: "tasks" })
    expect(reduceDetail(scrolled, "home", LIST)).toEqual({ changeIndex: 0, phase: "explore" })
    const last = { ...scrolled, phase: "archive" as const }
    expect(reduceDetail(last, "end", LIST)).toBe(last)
    expect(reduceDetail(last, "right", LIST)).toBe(last)
  })

  test("a key with no effect returns the same object", () => {
    const s = press(["end"])
    expect(reduceDetail(s, "right", LIST)).toBe(s)
    expect(reduceDetail(s, "end", LIST)).toBe(s)
    const top = initialDetailState(LIST)
    expect(reduceDetail(top, "prevChange", LIST)).toBe(top)
  })
})

describe("PgUp/PgDn scroll the panel", () => {
  test("they start from the initial position (the current task); page: the panel height minus one", () => {
    expect(scrollBy(["pageDown"]).scroll).toBe(15)
    expect(scrollBy(["pageUp"]).scroll).toBe(0)
    expect(scrollBy(["pageDown", "pageUp"]).scroll).toBe(6)
  })

  test("stops at 0 and at the maximum", () => {
    expect(scrollBy(["pageDown", "pageDown", "pageDown"]).scroll).toBe(20)
    expect(scrollBy(["pageUp", "pageUp"]).scroll).toBe(0)
    const bottom = scrollBy(["pageDown", "pageDown"])
    expect(bottom.scroll).toBe(20)
    expect(reduceDetail(bottom, "pageDown", LIST, PANEL(bottom))).toBe(bottom)
  })

  test("at the stop, without its own scroll, it stays without one (follows the current task)", () => {
    const top = initialDetailState(LIST)
    const fits: PanelScroll = { scroll: 0, max: 0, page: 9 }
    expect(reduceDetail(top, "pageDown", LIST, fits)).toBe(top)
    expect(reduceDetail(top, "pageUp", LIST, fits)).toBe(top)
  })

  test("an out-of-range scroll is clamped before moving", () => {
    const stale = { changeIndex: 0, phase: "apply" as const, scroll: 50 }
    expect(reduceDetail(stale, "pageUp", LIST, { scroll: 20, max: 20, page: 9 }).scroll).toBe(11)
  })

  test("without panel measurements they do nothing", () => {
    const s = initialDetailState(LIST)
    for (const key of ["pageUp", "pageDown"] as const) expect(reduceDetail(s, key, LIST)).toBe(s)
  })

  test("they change neither the change nor the phase", () => {
    expect(scrollBy(["pageDown"])).toEqual({ changeIndex: 0, phase: "apply", scroll: 15 })
  })
})

describe("the list changes", () => {
  test("if it shrinks, the index is clamped and the phase is kept", () => {
    const s = { changeIndex: 2, phase: "design" as const }
    expect(clampDetailState(s, changes("apply"))).toEqual({ changeIndex: 0, phase: "design" })
    expect(reduceDetail(s, "prevChange", changes("apply", "tasks"))).toEqual({ changeIndex: 0, phase: "apply" })
    expect(clampDetailState(s, LIST)).toBe(s)
  })

  test("the scroll is kept if the change remains; cleared if the index is clamped", () => {
    const s = { changeIndex: 1, phase: "tasks" as const, scroll: 4 }
    expect(clampDetailState(s, LIST)).toBe(s)
    expect(clampDetailState(s, changes("apply"))).toEqual({ changeIndex: 0, phase: "tasks" })
  })
})
