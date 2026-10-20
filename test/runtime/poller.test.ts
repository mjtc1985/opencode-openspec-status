import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Snapshot } from "../../src/model.ts"
import { createPoller, type Timers } from "../../src/runtime/poller.ts"
import type { Fsx, Run } from "../../src/sources/exec.ts"

const FIX = join(import.meta.dir, "..", "fixtures")
const raw = (name: string) => readFileSync(join(FIX, name), "utf8")
const ROOT = "/proyecto"

/** Fake timers: `fire(ms)` runs the intervals of that period. */
function fakeTimers() {
  const active = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const timers: Timers = {
    setInterval(fn, ms) {
      const id = next++
      active.set(id, { fn, ms })
      return id
    },
    clearInterval(handle) {
      active.delete(handle as number)
    },
  }
  const fire = (ms: number) => {
    for (const t of active.values()) if (t.ms === ms) t.fn()
  }
  return { timers, active, fire }
}

/** Only `<root>/.git` exists: just enough for review and git to run. */
const fsx: Fsx = {
  exists: async (p) => p === join(ROOT, ".git"),
  listDir: async () => [],
  readText: async () => undefined,
  mtime: async () => undefined,
}

type Source = "sdd" | "review" | "git"
const sourceOf = (cmd: string, args: string[]): Source => (cmd === "git" ? "git" : args[0] === "sdd-status" ? "sdd" : "review")

/** Fake `Run` with answers per source; each one can be a value, an error or a pending promise. */
function fakeRun() {
  const answers: Record<Source, () => Promise<string>> = {
    sdd: async () => raw("sdd-sample-app-default.json"),
    review: async () => raw("review-venue-finder.json"),
    git: async () => "",
  }
  const calls: Record<Source, number> = { sdd: 0, review: 0, git: 0 }
  const run: Run = (cmd, args) => {
    const s = sourceOf(cmd, args)
    calls[s]++
    return answers[s]()
  }
  return { run, answers, calls }
}

function deferred() {
  let resolve!: (v: string) => void
  const promise = new Promise<string>((r) => (resolve = r))
  return { promise, resolve }
}

/** Lets pending promises settle (the loaders chain several). */
const settle = () => new Promise((r) => setTimeout(r, 10))

function setup() {
  const t = fakeTimers()
  const r = fakeRun()
  let clock = 1_000
  const changes: Snapshot[] = []
  const poller = createPoller({ root: ROOT, run: r.run, fsx, timers: t.timers, now: () => clock, onChange: (s) => changes.push(s) })
  return { ...t, ...r, poller, changes, setClock: (ms: number) => (clock = ms) }
}

describe("createPoller", () => {
  test("intervals: SDD, ODD and git every 3 s; review every 10 s", async () => {
    const { active, fire, calls, poller } = setup()
    expect([...active.values()].map((t) => t.ms).sort()).toEqual([10_000, 3_000, 3_000, 3_000])
    fire(10_000)
    await settle()
    expect(calls).toEqual({ sdd: 0, review: 1, git: 0 })
    fire(3_000)
    await settle()
    expect(calls).toEqual({ sdd: 1, review: 1, git: 1 })
    expect(poller.snapshot().git.value).toEqual({ kind: "repo", dirty: false })
  })

  test("refresh loads every source", async () => {
    const { poller, answers } = setup()
    answers.git = async () => " M src/a.ts\n"
    await poller.refresh()
    const s = poller.snapshot()
    expect(s.root).toBe(ROOT)
    expect(s.sdd).toEqual({ value: { kind: "none", hint: "sdd-new" } })
    expect(s.review).toEqual({ value: { kind: "none" } })
    expect(s.git).toEqual({ value: { kind: "repo", dirty: true } })
    expect(s.odd).toEqual({ value: { kind: "none" } })
  })

  test("a failing source keeps its last value and is marked from the first failure; a success clears it", async () => {
    const { poller, answers, setClock } = setup()
    answers.git = async () => " M a\n"
    await poller.refresh()
    answers.git = async () => {
      throw new Error("git status: superó 5 s")
    }
    setClock(5_000)
    await poller.refresh()
    expect(poller.snapshot().git).toEqual({ value: { kind: "repo", dirty: true }, stale: { since: 5_000, error: "git status: superó 5 s" } })
    setClock(8_000)
    await poller.refresh()
    expect(poller.snapshot().git.stale?.since).toBe(5_000)
    expect(poller.snapshot().sdd.stale).toBeUndefined()
    answers.git = async () => ""
    await poller.refresh()
    expect(poller.snapshot().git).toEqual({ value: { kind: "repo", dirty: false } })
  })

  test("without gentle-ai: the source goes stale with a clear error", async () => {
    const { poller, answers } = setup()
    answers.sdd = async () => {
      throw new Error("gentle-ai no encontrado")
    }
    await poller.refresh()
    expect(poller.snapshot().sdd).toEqual({ value: { kind: "none" }, stale: { since: 1_000, error: "gentle-ai no encontrado" } })
  })

  test("reads of the same source do not overlap", async () => {
    const { poller, answers, calls, fire } = setup()
    const pending = deferred()
    answers.sdd = () => pending.promise
    const first = poller.refresh()
    fire(3_000)
    fire(3_000)
    const second = poller.refresh()
    expect(calls.sdd).toBe(1)
    pending.resolve(raw("sdd-sample-app-default.json"))
    await Promise.all([first, second])
    expect(poller.snapshot().sdd.value).toEqual({ kind: "none", hint: "sdd-new" })
    answers.sdd = async () => raw("sdd-sample-app-default.json")
    await poller.refresh()
    expect(calls.sdd).toBe(2)
  })

  test("onChange only when the snapshot changes", async () => {
    const { poller, changes, answers } = setup()
    await poller.refresh()
    const afterFirst = changes.length
    expect(afterFirst).toBeGreaterThan(0)
    await poller.refresh()
    await poller.refresh()
    expect(changes).toHaveLength(afterFirst)
    answers.git = async () => "?? nuevo.txt\n"
    await poller.refresh()
    expect(changes).toHaveLength(afterFirst + 1)
    expect(changes.at(-1)!.git.value).toEqual({ kind: "repo", dirty: true })
  })

  test("dispose stops the timers and drops whatever arrives later", async () => {
    const { poller, active, fire, calls, changes, answers } = setup()
    const pending = deferred()
    answers.git = () => pending.promise
    const inFlight = poller.refresh()
    const before = changes.length
    poller.dispose()
    expect(active.size).toBe(0)
    pending.resolve(" M a\n")
    await inFlight
    fire(3_000)
    fire(10_000)
    await poller.refresh()
    expect(calls).toEqual({ sdd: 1, review: 1, git: 1 })
    expect(poller.snapshot().git.value).toEqual({ kind: "none" })
    expect(changes).toHaveLength(before)
  })
})

test("the pin is checked on every SDD and ODD read", async () => {
  const t = fakeTimers()
  const r = fakeRun()
  let asked = 0
  const poller = createPoller({ root: ROOT, run: r.run, fsx, timers: t.timers, pin: () => (asked++, { kind: "odd", name: "x", branch: "" }) })
  await poller.refresh()
  expect(asked).toBe(2)
  poller.dispose()
})

describe("onListed: new changes and features", () => {
  /** One SDD change and one ODD document in memory, with their dates; more can be added. */
  function workFs() {
    const changes = new Map<string, number>([["fidelizacion-puntos", 3_000]])
    const docs = new Map<string, number>([["modo-oscuro-carta.md", 1_000]])
    const changesDir = join(ROOT, "openspec", "changes")
    const oddDir = join(ROOT, "odd", "tasks")
    const listed: string[] = []
    const f: Fsx = {
      exists: async (p) => p === join(ROOT, ".git"),
      listDir: async (p) => {
        listed.push(p)
        if (p === changesDir) return [...changes.keys(), "archive"].map((name) => ({ name, dir: true }))
        if (p.startsWith(changesDir + "/")) return [{ name: "proposal.md", dir: false }]
        if (p === oddDir) return [...docs.keys(), "notas.txt"].map((name) => ({ name, dir: false }))
        return []
      },
      readText: async () => undefined,
      mtime: async (p) => {
        if (p.startsWith(changesDir + "/")) return changes.get(p.slice(changesDir.length + 1).split("/")[0]!)
        if (p.startsWith(oddDir + "/")) return docs.get(p.slice(oddDir.length + 1))
        return undefined
      },
    }
    return { fsx: f, changes, docs, listed, changesDir }
  }

  test("without onListed changes are not listed unless sdd-status asks for it", async () => {
    const w = workFs()
    const poller = createPoller({ root: ROOT, run: fakeRun().run, fsx: w.fsx, timers: fakeTimers().timers })
    await poller.refresh()
    expect(w.listed).not.toContain(w.changesDir)
    poller.dispose()
  })

  test("lists changes (without archive) and .md documents before reading their state", async () => {
    const w = workFs()
    const r = fakeRun()
    const order: string[] = []
    const run: Run = (cmd, args, opts) => (order.push(`run:${sourceOf(cmd, args)}`), r.run(cmd, args, opts))
    const listings: unknown[] = []
    const poller = createPoller({
      root: ROOT,
      run,
      fsx: w.fsx,
      timers: fakeTimers().timers,
      onListed: (l) => (order.push(l.sdd ? "listed:sdd" : "listed:odd"), listings.push(l), false),
    })
    await poller.refresh()
    expect(listings).toContainEqual({ sdd: [{ name: "fidelizacion-puntos", updatedAt: 3_000 }] })
    expect(listings).toContainEqual({ odd: [{ name: "modo-oscuro-carta", updatedAt: 1_000 }] })
    expect(order.indexOf("listed:sdd")).toBeLessThan(order.indexOf("run:sdd"))
    poller.dispose()
  })

  test("when the pin changes, the other source is reread (also while it was reading)", async () => {
    const w = workFs()
    const r = fakeRun()
    let seenOdd = 0
    const poller = createPoller({
      root: ROOT,
      run: r.run,
      fsx: w.fsx,
      timers: fakeTimers().timers,
      onListed: (l) => {
        if (l.odd) seenOdd++
        return l.sdd?.some((c) => c.name === "prueba-nueva") === true || l.odd?.some((d) => d.name === "otra-feature") === true
      },
    })
    await poller.refresh()
    expect(r.calls.sdd).toBe(1)
    expect(seenOdd).toBe(1)
    w.docs.set("otra-feature.md", 9_000)
    await poller.refresh()
    await settle()
    // This refresh's SDD read was already in flight: it is repeated when it finishes.
    expect(r.calls.sdd).toBe(3)
    w.docs.delete("otra-feature.md")
    w.changes.set("prueba-nueva", 10_000)
    const before = seenOdd
    await poller.refresh()
    await settle()
    expect(seenOdd).toBe(before + 2)
    poller.dispose()
  })

  test("if onListed throws, the source is read anyway and does not go stale", async () => {
    const w = workFs()
    const poller = createPoller({
      root: ROOT,
      run: fakeRun().run,
      fsx: w.fsx,
      timers: fakeTimers().timers,
      onListed: () => {
        throw new Error("boom")
      },
    })
    await poller.refresh()
    expect(poller.snapshot().sdd).toEqual({ value: { kind: "none", hint: "sdd-new" } })
    expect(poller.snapshot().odd.stale).toBeUndefined()
    poller.dispose()
  })
})

test("watchdog: a read that never finishes marks the source stale and allows a retry", async () => {
  let hang = true
  const run: Run = async (_cmd, args) => {
    if (hang && args[0] === "sdd-status") return new Promise<string>(() => {})
    return args[0] === "sdd-status" ? JSON.stringify({ schemaName: "gentle-ai.sdd-status", schemaVersion: 2, changeName: null, nextRecommended: "sdd-new", blockedReasons: [] }) : ""
  }
  const t = fakeTimers()
  const poller = createPoller({ root: ROOT, run, fsx, timers: t.timers, watchdogMs: 20 })
  await poller.refresh()
  expect(poller.snapshot().sdd.stale?.error).toContain("lectura colgada")
  hang = false
  await poller.refresh()
  expect(poller.snapshot().sdd.stale).toBeUndefined()
  poller.dispose()
})
