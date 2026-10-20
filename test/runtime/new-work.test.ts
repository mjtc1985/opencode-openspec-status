import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createNewWorkPinner, createNewWorkTracker, detectNew, type Listing, type Stamped } from "../../src/runtime/new-work.ts"
import { type Pin, parsePin, togglePin } from "../../src/sources/choice.ts"
import type { Fsx } from "../../src/sources/exec.ts"

const ROOT = "/proyecto"
const at = (name: string, updatedAt: number): Stamped => ({ name, updatedAt })
const SDD = [at("fidelizacion-puntos", 3_000), at("ticket-digital", 2_000)]
const ODD = [at("modo-oscuro-carta", 1_000)]
const DEMO: Listing = { sdd: SDD, odd: ODD }

describe("detectNew", () => {
  const seen = new Set(["sdd:fidelizacion-puntos", "sdd:ticket-digital", "odd:modo-oscuro-carta"])

  test("nothing new: undefined (also without listings)", () => {
    expect(detectNew(seen, DEMO)).toBeUndefined()
    expect(detectNew(seen, {})).toBeUndefined()
  })

  test("an SDD change or an ODD feature that was not there", () => {
    expect(detectNew(seen, { sdd: [...SDD, at("test-new", 500)] })).toEqual({ kind: "sdd", name: "test-new" })
    expect(detectNew(seen, { odd: [...ODD, at("otra-feature", 500)] })).toEqual({ kind: "odd", name: "otra-feature" })
  })

  test("several at once: the most recently modified; on an SDD/ODD tie, SDD", () => {
    expect(detectNew(seen, { sdd: [at("vieja", 1_000), at("nueva", 5_000)], odd: [at("media", 3_000)] })).toEqual({ kind: "sdd", name: "nueva" })
    expect(detectNew(seen, { sdd: [at("vieja", 1_000)], odd: [at("media", 3_000)] })).toEqual({ kind: "odd", name: "media" })
    expect(detectNew(seen, { sdd: [at("igual", 3_000)], odd: [at("igual", 3_000)] })).toEqual({ kind: "sdd", name: "igual" })
  })

  test("the same name in the other methodology is new", () => {
    expect(detectNew(seen, { odd: [at("ticket-digital", 1)] })).toEqual({ kind: "odd", name: "ticket-digital" })
  })
})

describe("createNewWorkTracker", () => {
  test("each source's first read is the baseline: what was already there does not trigger", () => {
    const t = createNewWorkTracker()
    expect(t.observe("A", { sdd: SDD })).toBeUndefined()
    // ODD had not been read in this session yet: its first read does not trigger either.
    expect(t.observe("A", { odd: ODD })).toBeUndefined()
    expect(t.observe("A", DEMO)).toBeUndefined()
  })

  test("a new SDD change and then a new ODD feature: each triggers once", () => {
    const t = createNewWorkTracker()
    t.observe("A", DEMO)
    expect(t.observe("A", { sdd: [at("test-new", 9_000), ...SDD] })).toEqual({ kind: "sdd", name: "test-new" })
    expect(t.observe("A", { sdd: [at("test-new", 9_500), ...SDD] })).toBeUndefined()
    expect(t.observe("A", { odd: [at("otra-feature", 10_000), ...ODD] })).toEqual({ kind: "odd", name: "otra-feature" })
    expect(t.observe("A", { odd: [at("otra-feature", 10_000), ...ODD] })).toBeUndefined()
  })

  test("two new ones in the same read: the newest, and the other does not trigger later", () => {
    const t = createNewWorkTracker()
    t.observe("A", DEMO)
    const both: Listing = { sdd: [at("uno", 5_000), at("dos", 7_000), ...SDD] }
    expect(t.observe("A", both)).toEqual({ kind: "sdd", name: "dos" })
    expect(t.observe("A", both)).toBeUndefined()
  })

  test("editing what was already there does not trigger even if it becomes the newest", () => {
    const t = createNewWorkTracker()
    t.observe("A", DEMO)
    expect(t.observe("A", { sdd: [at("ticket-digital", 99_000), at("fidelizacion-puntos", 3_000)], odd: [at("modo-oscuro-carta", 99_500)] })).toBeUndefined()
  })

  test("what disappears and comes back (e.g. on a branch switch) does not trigger; archived items never reach the listing", () => {
    const t = createNewWorkTracker()
    t.observe("A", DEMO)
    expect(t.observe("A", { sdd: [], odd: [] })).toBeUndefined()
    expect(t.observe("A", DEMO)).toBeUndefined()
  })

  test("each session has its own baseline; a session opened later does not trigger on what was already there", () => {
    const t = createNewWorkTracker()
    t.observe("A", DEMO)
    const withNew: Listing = { sdd: [at("test-new", 9_000), ...SDD], odd: ODD }
    // B opens for the first time when test-new already exists: it is part of its baseline.
    expect(t.observe("B", withNew)).toBeUndefined()
    expect(t.observe("A", withNew)).toEqual({ kind: "sdd", name: "test-new" })
  })

  test("what appears while a session is in front belongs to that session: switching to another does not trigger", () => {
    const t = createNewWorkTracker()
    t.observe("A", DEMO)
    t.observe("B", DEMO)
    const withNew: Listing = { odd: [at("otra-feature", 9_000), ...ODD] }
    expect(t.observe("B", withNew)).toEqual({ kind: "odd", name: "otra-feature" })
    expect(t.observe("A", withNew)).toBeUndefined()
  })

  test("without a session (home screen) nothing is checked and no baseline is taken", () => {
    const t = createNewWorkTracker()
    expect(t.observe(undefined, DEMO)).toBeUndefined()
    // What was listed on the home screen does not count for the session: its first read is its baseline.
    expect(t.observe("A", { sdd: [at("test-new", 9_000), ...SDD], odd: ODD })).toBeUndefined()
  })
})

/** Only `.git/HEAD` with branch `branch`. */
const gitFsx = (branch: string): Fsx => ({
  exists: async () => false,
  listDir: async () => [],
  readText: async (p) => (p === join(ROOT, ".git", "HEAD") ? `ref: refs/heads/${branch}\n` : undefined),
  mtime: async () => undefined,
})

/** Fake KV with the same rule as `tui.tsx` (first `null`, then the value). */
function fakeKv() {
  const store = new Map<string, unknown>()
  const writes: [string, unknown][] = []
  const set = (key: string, value: unknown) => {
    writes.push([key, value])
    store.set(key, value)
  }
  return { store, writes, set }
}

describe("createNewWorkPinner", () => {
  function setup() {
    const kv = fakeKv()
    let session: string | undefined = "A"
    const onListed = createNewWorkPinner({
      root: ROOT,
      fsx: gitFsx("feature/1187-fidelizacion-puntos"),
      session: () => session,
      write: (s, pin) => {
        kv.set(s, null)
        kv.set(s, pin)
      },
    })
    return { kv, onListed, setSession: (s: string | undefined) => (session = s) }
  }

  test("pins the new item for the current session, on its branch and with origin new", async () => {
    const { kv, onListed } = setup()
    expect(await onListed(DEMO)).toBe(false)
    expect(kv.writes).toEqual([])
    expect(await onListed({ sdd: [at("test-new", 9_000), ...SDD] })).toBe(true)
    const pin = { kind: "sdd", name: "test-new", branch: "feature/1187-fidelizacion-puntos", origin: "new" }
    expect(kv.writes).toEqual([
      ["A", null],
      ["A", pin],
    ])
    expect(parsePin(kv.store.get("A"))).toEqual(pin as Pin)
  })

  test("a later Enter pins by hand (no origin) and something newer replaces it again", async () => {
    const { kv, onListed } = setup()
    await onListed(DEMO)
    await onListed({ odd: [at("otra-feature", 9_000), ...ODD] })
    const auto = parsePin(kv.store.get("A"))
    expect(auto).toMatchObject({ kind: "odd", name: "otra-feature", origin: "new" })
    const manual = togglePin(auto, "sdd", "ticket-digital", "feature/1187-fidelizacion-puntos")
    expect(manual).toEqual({ kind: "sdd", name: "ticket-digital", branch: "feature/1187-fidelizacion-puntos" })
    kv.set("A", null)
    kv.set("A", manual)
    expect(await onListed({ odd: [at("otra-feature", 9_000), ...ODD] })).toBe(false)
    expect(parsePin(kv.store.get("A"))).toEqual(manual!)
    expect(await onListed({ sdd: [at("tercera", 12_000), ...SDD] })).toBe(true)
    expect(parsePin(kv.store.get("A"))).toMatchObject({ kind: "sdd", name: "tercera", origin: "new" })
  })

  test("each session writes to its own key; nothing is written on the home screen", async () => {
    const { kv, onListed, setSession } = setup()
    await onListed(DEMO)
    setSession("B")
    await onListed(DEMO)
    expect(await onListed({ sdd: [at("de-b", 9_000), ...SDD] })).toBe(true)
    expect(kv.store.has("A")).toBe(false)
    expect(kv.store.get("B")).toMatchObject({ name: "de-b" })
    setSession(undefined)
    expect(await onListed({ sdd: [at("en-inicio", 10_000), at("de-b", 9_000), ...SDD] })).toBe(false)
    expect(kv.writes.every(([key]) => key === "B")).toBe(true)
  })
})
