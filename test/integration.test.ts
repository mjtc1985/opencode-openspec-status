// End to end without OpenCode: real gentle-ai fixtures in temporary folders →
// fake `Run` → poller (with the `sources/` loaders) → `buildView` → sidebar,
// prompt indicator and full screen.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type Line, SIDEBAR_WIDTH } from "../src/model.ts"
import { createPoller, type Timers } from "../src/runtime/poller.ts"
import type { Run } from "../src/sources/exec.ts"
import { compactLabel } from "../src/view/compact.ts"
import { buildView } from "../src/view/flow-view.ts"
import { renderFull } from "../src/view/full.ts"
import { renderSidebar } from "../src/view/sidebar.ts"
import { displayWidth, lineText } from "../src/view/text.ts"

const FIX = join(import.meta.dir, "fixtures")
const raw = (name: string) => readFileSync(join(FIX, name), "utf8")
const HOME = "/home/dev/projects"

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-int-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const noTimers: Timers = { setInterval: () => 0, clearInterval: () => {} }

function write(file: string, text: string, mtimeSec?: number) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec)
}

/** Recreates the files of a `stat` listing (mtime in s and path) under `root`. */
function replayMtimes(listing: string, from: string, root: string) {
  for (const row of raw(listing).split("\n").filter(Boolean)) {
    const mtime = Number(row.split(" ")[0])
    const path = row.slice(row.indexOf(from) + from.length)
    write(join(root, path), "# fixture\n", mtime)
  }
}

type Answers = { sdd: (change?: string) => string; review?: string; lineage?: string; git?: string }

/** `Run` that answers with fixtures and records every call. */
function fixtureRun(answers: Answers) {
  const calls: string[][] = []
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === "git") return answers.git ?? ""
    if (args[0] === "sdd-status") return answers.sdd(args.length === 5 ? args[1] : undefined)
    if (args.length === 4 && answers.review !== undefined) return answers.review
    if (args.length === 7 && answers.lineage !== undefined) return answers.lineage
    throw new Error(`no fixture for ${args.join(" ")}`)
  }
  return { run, calls }
}

const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime()

async function render(root: string, run: Run) {
  const poller = createPoller({ root, run, timers: noTimers, now: () => NOW })
  await poller.refresh()
  const snapshot = poller.snapshot()
  poller.dispose()
  const view = buildView(snapshot, NOW)
  const sidebar = renderSidebar(view)
  const label = compactLabel(view)
  const full = renderFull(view, 120)
  return { snapshot, sidebar, label: label && lineText(label), full, text: sidebar.map(lineText).join("\n"), fullText: full.map(lineText).join("\n") }
}

function expectFits(lines: Line[], width: number) {
  for (const line of lines) expect(displayWidth(lineText(line)), `«${lineText(line)}»`).toBeLessThanOrEqual(width)
}

describe("integration with real fixtures", () => {
  test("sample-app: ODD with T7 in progress and a review with corrections and lenses", async () => {
    const root = join(tmp, "sample-app")
    const entry = join(root, ".git", "gentle-ai", "review-transactions", "v2", "review-ff3e92437e221e59-r1")
    write(join(entry, "review-state.json"), raw("review-state-sample-app-r1.json"))
    write(join(root, "odd", "tasks", "sample-app-skeleton.md"), raw("odd-sample-app-skeleton.md"))
    const alk = `${HOME}/sample-app`
    const { run, calls } = fixtureRun({
      sdd: () => raw("sdd-sample-app-default.json").split(alk).join(root),
      review: raw("review-sample-app.json").split(alk).join(root),
      lineage: raw("review-sample-app-lineage.json").split(alk).join(root),
      git: " M src/opencode/tui.tsx\n",
    })
    const r = await render(root, run)
    expectFits(r.sidebar, SIDEBAR_WIDTH)
    expectFits(r.full, 120)
    expect(r.snapshot.review.stale).toBeUndefined()
    expect(r.text).toContain("ODD · sample-app-skeleton")
    expect(r.text).toContain("inferido")
    expect(r.text).toContain("implementar · T7 de 9")
    expect(r.text).toContain("revisión ✗")
    expect(r.text).toContain("▸ revisión: correction_required")
    expect(r.text).toContain("✗ risk 3")
    expect(r.text).toContain("✗ reliability 1")
    expect(r.text).toContain("○ cerrar  (2 pendientes)")
    expect(r.label).toBe("ODD · T7/9 · rev ✗")
    expect(r.fullText).toContain("linaje review-ff3e92437e221e59-r1")
    expect(r.fullText).toContain("◉ T7 End-to-end check")
    expect(r.fullText).toContain("esc: volver")
    // Both review calls are the read-only ones, never `review start`.
    const review = calls.filter((c) => c[1] === "review").map((c) => c.slice(0, 3).join(" "))
    expect(review).toEqual(["gentle-ai review status", "gentle-ai review status"])
    expect(calls.some((c) => c.join(" ").includes("--lineage=review-ff3e92437e221e59-r1"))).toBe(true)
  })

  test("venue-finder: blocked SDD change", async () => {
    const root = join(tmp, "venue-finder")
    mkdirSync(join(root, ".git"), { recursive: true })
    const venue = `${HOME}/venue-finder`
    replayMtimes("mtimes-venue-finder-find-alternative-venue.txt", venue, root)
    const { run } = fixtureRun({
      sdd: () => raw("sdd-venue-finder-find-alternative-venue.json").split(venue).join(root),
      review: raw("review-venue-finder.json").split(venue).join(root),
    })
    const r = await render(root, run)
    expectFits(r.sidebar, SIDEBAR_WIDTH)
    expectFits(r.full, 120)
    expect(r.text).toContain("SDD · find-alternative-venue")
    expect(r.text).toContain("✗ apply  4/15")
    expect(r.text).toContain("✗ apply bloqueado: faltan spec y")
    expect(r.text).toContain("○ spec  ▸ siguiente")
    expect(r.label).toBe("SDD ✗ bloqueado")
    expect(r.fullText).toContain("✗ apply bloqueado: faltan spec y design")
  })

  test("homelab: several changes, the newest is picked; without git neither review nor git runs", async () => {
    const root = join(tmp, "homelab")
    const homelab = `${HOME}/homelab`
    replayMtimes("mtimes-homelab-deploy-agent-rpi.txt", homelab, root)
    replayMtimes("mtimes-homelab-uptime-diagnostics.txt", homelab, root)
    const { run, calls } = fixtureRun({
      sdd: (change) => raw(change ? `sdd-homelab-${change}.json` : "sdd-homelab-default.json").split(homelab).join(root),
    })
    const r = await render(root, run)
    expectFits(r.sidebar, SIDEBAR_WIDTH)
    expectFits(r.full, 120)
    expect(r.text).toContain("(1 de 2)")
    expect(r.text).toContain("✓ apply  11/11")
    expect(r.text).toContain("○ archive  ▸ siguiente")
    expect(r.text).toContain("revisión: sin git")
    expect(r.label).toBe("SDD · apply 11/11")
    expect(r.fullText).toContain("SDD · uptime-diagnostics (1 de 2)")
    expect(r.fullText).toContain("otros cambios: deploy-agent-rpi")
    expect(r.snapshot.review.value).toEqual({ kind: "unavailable", reason: "sin git" })
    expect(r.snapshot.git.value).toEqual({ kind: "none" })
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ["gentle-ai", "sdd-status", "--json"],
      ["gentle-ai", "sdd-status", "uptime-diagnostics"],
    ])
  })

  test("pricing-service: nothing active", async () => {
    const root = join(tmp, "pricing-service")
    mkdirSync(join(root, ".git"), { recursive: true })
    const pricing = `${HOME}/pricing-service`
    const { run } = fixtureRun({
      sdd: () => raw("sdd-pricing-service-default.json").split(pricing).join(root),
      review: raw("review-pricing-service.json").split(pricing).join(root),
    })
    const r = await render(root, run)
    expectFits(r.sidebar, SIDEBAR_WIDTH)
    expectFits(r.full, 120)
    expect(r.text).toContain("◇ openspec-status")
    expect(r.text).toContain("nada activo")
    expect(r.text).toContain("empieza un cambio OpenSpec (sdd-new")
    expect(r.label).toBeUndefined()
    expect(r.fullText).toContain("explore → propose → spec → design → tasks → apply → verify → archive")
    expect(r.snapshot.review.value).toEqual({ kind: "none" })
  })
})
