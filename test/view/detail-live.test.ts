import { describe, expect, test } from "bun:test"
import type { SessionActivity } from "../../src/model.ts"
import { initialDetailState } from "../../src/view/detail-state.ts"
import { buildView, detailLive } from "../../src/view/flow-view.ts"
import { renderSddDetail } from "../../src/view/sdd-detail.ts"
import { lineText } from "../../src/view/text.ts"
import { omDecimalsStatus, twoChanges } from "./detail-fixtures.ts"
import { NOW, change, phases, snapshot } from "./snapshots.ts"

const S = 1000
const busy = (seconds: number): SessionActivity => ({ state: "busy", since: NOW - seconds * S })
const spec = change({
  name: "add-price-cache",
  phases: phases("dddttttt"),
  current: "spec",
  next: "design",
  nextRecommended: "design",
  phaseUpdatedAt: { spec: NOW - 10 * S },
})
const liveOf = (activity?: SessionActivity) => detailLive(buildView(snapshot({ sdd: spec }), NOW, activity ? { activity } : {}))

describe("SDD detail: work in progress", () => {
  test("detailLive: writing the phase with a clock, working, waiting or nothing", () => {
    expect(liveOf(busy(84))).toEqual({ name: "add-price-cache", writing: "spec", text: "◉ escribiendo spec 1:24", tone: "accent" })
    const quiet = change({ ...spec, phaseUpdatedAt: { spec: NOW - 3600 * S } })
    expect(detailLive(buildView(snapshot({ sdd: quiet }), NOW, { activity: busy(5) }))).toEqual({ name: "add-price-cache", text: "◉ trabajando 0:05", tone: "accent" })
    expect(liveOf({ state: "waiting" })).toEqual({ name: "add-price-cache", text: "esperando tu OK", tone: "warning" })
    expect(liveOf()).toBeUndefined()
  })

  test("the change row carries the work in progress and the strip marks the phase being written", () => {
    const model = { ...twoChanges(), live: { name: "add-price-cache", writing: "spec" as const, text: "◉ escribiendo spec 1:24", tone: "accent" as const } }
    const lines = renderSddDetail(model, initialDetailState(model.changes), 100).map(lineText)
    expect(lines.find((l) => l.includes("add-price-cache"))).toContain("◉ escribiendo spec 1:24")
    expect(lines.find((l) => l.includes("fix-om-decimals"))).not.toContain("escribiendo")
    expect(lines.find((l) => l.includes("explore ─"))).toContain("◉ spec")
  })

  test("without a session (home screen) the key bar does not offer «enter pin»", () => {
    const model = twoChanges()
    const bar = (canPin?: boolean) => lineText(renderSddDetail(model, initialDetailState(model.changes), 100, canPin === undefined ? {} : { canPin }).at(-1)!)
    expect(bar()).toContain("enter fijar")
    expect(bar(false)).not.toContain("enter fijar")
    expect(bar(false)).toContain("esc volver")
  })

  test("opens on the sidebar's change, at its current phase", () => {
    const changes = [{ status: change({ current: "apply" }) }, { status: omDecimalsStatus() }]
    expect(initialDetailState(changes, 1)).toEqual({ changeIndex: 1, phase: omDecimalsStatus().current })
    expect(initialDetailState(changes, -1)).toEqual({ changeIndex: 0, phase: "apply" })
    expect(initialDetailState(changes, 9)).toEqual({ changeIndex: 0, phase: "apply" })
  })
})
