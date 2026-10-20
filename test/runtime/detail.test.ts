import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SddChange } from "../../src/model.ts"
import { createDetailLoader } from "../../src/runtime/detail.ts"
import type { Run } from "../../src/sources/exec.ts"
import { isAllowed } from "../../src/sources/exec.ts"

const FIX = join(import.meta.dir, "..", "fixtures")
const DETAIL_FIX = join(FIX, "openspec-synth-detail")
const tmp = mkdtempSync(join(tmpdir(), "openspec-status-detail-loader-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** Temporary project with the two synthetic changes; add-price-cache is the newest. */
function project(name: string): string {
  const root = join(tmp, name)
  const changes = join(root, "openspec", "changes")
  mkdirSync(changes, { recursive: true })
  cpSync(DETAIL_FIX, changes, { recursive: true })
  mkdirSync(join(changes, "archive", "viejo"), { recursive: true })
  const old = new Date(1_700_000_000_000)
  const recent = new Date(1_800_000_000_000)
  for (const f of ["proposal.md", "tasks.md", ".openspec.yaml"]) utimesSync(join(changes, "fix-om-decimals", f), old, old)
  utimesSync(join(changes, "add-price-cache", "tasks.md"), recent, recent)
  return root
}

const ARTIFACT_FILES = {
  proposal: ["proposal.md"],
  specs: ["specs/price-cache/spec.md", "specs/pricing-api/spec.md"],
  design: ["design.md"],
  tasks: ["tasks.md"],
  applyProgress: ["apply-progress.md"],
  verifyReport: ["verify-report.md"],
} as const

/** Real sdd-status JSON (c5) with the name and paths rewritten to the temporary project. */
function statusJson(root: string, change: string): string {
  const json = JSON.parse(readFileSync(join(FIX, "sdd-synth-c5-tasks-partial.json"), "utf8"))
  const dir = join(root, "openspec", "changes", change)
  json.changeName = change
  json.changeRoot = dir
  json.planningHome.path = join(root, "openspec")
  for (const [k, files] of Object.entries(ARTIFACT_FILES)) {
    const paths = files.map((f) => join(dir, f)).filter((p) => existsSync(p))
    json.artifactPaths[k] = paths
    json.contextFiles[k] = paths
    json.artifacts[k] = paths.length ? "done" : "missing"
  }
  return JSON.stringify(json)
}

type Answer = (change: string) => Promise<string>

/** Fake `Run`: answers per change and checks that only allowed forms are requested. */
function fakeRun(root: string, answer?: Answer) {
  const calls: string[][] = []
  const run: Run = async (cmd, args) => {
    if (!isAllowed(cmd, args)) throw new Error(`not allowed: ${cmd} ${args.join(" ")}`)
    calls.push([cmd, ...args])
    const change = args[1]!
    return answer ? answer(change) : statusJson(root, change)
  }
  return { run, calls }
}

describe("createDetailLoader", () => {
  test("the branch: it is returned and its work item only goes to the change that matches it", async () => {
    const root = project("rama")
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, ".git", "config"), '[remote "origin"]\n\turl = https://dev.azure.com/contoso/Tienda/_git/precios\n')
    const head = (branch: string) => writeFileSync(join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`)
    const refs = async () => {
      const model = await createDetailLoader({ root, run: fakeRun(root).run, cacheMs: 0 }).load()
      return { branch: model.branch, refs: model.changes.map((c) => c.detail?.workItem?.ref) }
    }
    // By name: fix-om-decimals (no work item of its own) takes the branch's; add-price-cache keeps its own.
    head("feature/99-fix-om-decimals")
    expect(await refs()).toEqual({ branch: "feature/99-fix-om-decimals", refs: ["AB#48213", "AB#99"] })
    // The branch belongs to no change: nobody takes its work item.
    head("feature/99-otra-cosa")
    expect(await refs()).toEqual({ branch: "feature/99-otra-cosa", refs: ["AB#48213", undefined] })
    // By work item: the branch is add-price-cache's, so fix-om-decimals gets nothing.
    head("feature/48213-fix-om-decimals")
    expect(await refs()).toEqual({ branch: "feature/48213-fix-om-decimals", refs: ["AB#48213", undefined] })
  })

  test("one sdd-status per active change, newest to oldest, with detail", async () => {
    const root = project("ok")
    const { run, calls } = fakeRun(root)
    const model = await createDetailLoader({ root, run }).load()
    expect(calls).toEqual([
      ["gentle-ai", "sdd-status", "add-price-cache", "--json", "--cwd", root],
      ["gentle-ai", "sdd-status", "fix-om-decimals", "--json", "--cwd", root],
    ])
    expect(model.error).toBeUndefined()
    expect(model.changes.map((c) => c.status.name)).toEqual(["add-price-cache", "fix-om-decimals"])
    const [price, om] = model.changes
    expect(price!.status.phases.verify).toBe("done")
    expect(price!.status.currentTask).toBeDefined()
    expect(price!.detail?.specs.map((s) => s.capability)).toEqual(["price-cache", "pricing-api"])
    expect(price!.detail?.workItem?.ref).toBe("AB#48213")
    expect(om!.status.phases.spec).toBe("todo")
    expect(om!.detail?.specs).toEqual([])
    expect(om!.detail?.tasks?.groups.length).toBeGreaterThan(0)
  })

  test("a change folder named like an option (--help) is not queried", async () => {
    const root = project("opcion")
    mkdirSync(join(root, "openspec", "changes", "--help"))
    writeFileSync(join(root, "openspec", "changes", "--help", "proposal.md"), "# h")
    const { run, calls } = fakeRun(root)
    const model = await createDetailLoader({ root, run }).load()
    expect(model.error).toBeUndefined()
    expect(calls.map((c) => c[2])).toEqual(["add-price-cache", "fix-om-decimals"])
  })

  test("a failing change does not hide the others: it is summarized as an error", async () => {
    const root = project("fail")
    const { run } = fakeRun(root, async (change) => {
      if (change === "add-price-cache") throw new Error("gentle-ai sdd-status: superó 5 s")
      return statusJson(root, change)
    })
    const model = await createDetailLoader({ root, run }).load()
    expect(model.changes.map((c) => c.status.name)).toEqual(["fix-om-decimals"])
    expect(model.error).toBe("no se pudo leer 1 de 2 cambios: add-price-cache: gentle-ai sdd-status: superó 5 s")
  })

  test("non-JSON output, incoherent JSON and a change that disappeared", async () => {
    const root = project("bad")
    const { run } = fakeRun(root, async (change) => {
      if (change === "add-price-cache") return "no es json"
      const json = JSON.parse(statusJson(root, change))
      json.taskProgress.completed = 99
      return JSON.stringify(json)
    })
    const model = await createDetailLoader({ root, run }).load()
    expect(model.changes).toEqual([])
    expect(model.error).toStartWith("no se pudo leer 2 de 2 cambios: add-price-cache: la salida de sdd-status no es JSON; fix-om-decimals: hay más tareas completadas")

    const gone = fakeRun(root, async () => readFileSync(join(FIX, "sdd-venue-finder-nonexistent-change.json"), "utf8"))
    const empty = await createDetailLoader({ root, run: gone.run }).load()
    expect(empty).toEqual({ changes: [] })
  })

  test("no change folders: uses the poll's change (e.g. Engram) without detail", async () => {
    const root = join(tmp, "engram")
    mkdirSync(root, { recursive: true })
    const { run, calls } = fakeRun(root)
    const fallback = { kind: "change", name: "solo-engram", store: "engram", current: "propose" } as unknown as SddChange
    const model = await createDetailLoader({ root, run }).load(fallback)
    expect(calls).toEqual([])
    expect(model).toEqual({ changes: [{ status: fallback }] })
    expect(await createDetailLoader({ root, run }).load({ kind: "none" })).toEqual({ changes: [] })
    expect(await createDetailLoader({ root, run }).load()).toEqual({ changes: [] })
  })

  test("cache: nothing runs again within cacheMs", async () => {
    const root = project("cache")
    const { run, calls } = fakeRun(root)
    let t = 1_000
    const loader = createDetailLoader({ root, run, now: () => t, cacheMs: 3_000 })
    const first = await loader.load()
    t += 2_999
    expect(await loader.load()).toBe(first)
    expect(calls).toHaveLength(2)
    t += 1
    const second = await loader.load()
    expect(second).not.toBe(first)
    expect(calls).toHaveLength(4)
  })

  test("two concurrent loads share the same promise", async () => {
    const root = project("inflight")
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { run, calls } = fakeRun(root, async (change) => {
      await gate
      return statusJson(root, change)
    })
    const loader = createDetailLoader({ root, run })
    const a = loader.load()
    const b = loader.load()
    expect(b).toBe(a)
    release()
    const [ma, mb] = await Promise.all([a, b])
    expect(ma).toBe(mb)
    expect(calls).toHaveLength(2)
  })

  test("after dispose nothing runs and the last model is returned", async () => {
    const root = project("dispose")
    const { run, calls } = fakeRun(root)
    const loader = createDetailLoader({ root, run, cacheMs: 0 })
    const model = await loader.load()
    loader.dispose()
    expect(await loader.load()).toBe(model)
    expect(calls).toHaveLength(2)
  })
})
