import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { SddChange, SddState } from "../../src/model.ts"
import { type Fsx, type Run, nodeFs, sddStatusArgs } from "../../src/sources/exec.ts"
import type { Pin } from "../../src/sources/choice.ts"
import { activeChanges, firstOpenTask, loadSdd, parseSddStatus, readSddFiles, STALE_TOLERANCE_MS } from "../../src/sources/sdd.ts"

const FIX = join(import.meta.dir, "..", "fixtures")
const raw = (name: string) => readFileSync(join(FIX, name), "utf8")
const fixture = (name: string) => JSON.parse(raw(name)) as Record<string, any>
const NO_FILES = { mtimes: {} }

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-sdd-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function asChange(s: SddState): SddChange {
  if (s.kind !== "change") throw new Error(`expected a change, got ${JSON.stringify(s)}`)
  return s
}

describe("no active change", () => {
  test("sample-app and pricing-service: none with the sdd-new hint", () => {
    expect(parseSddStatus(fixture("sdd-sample-app-default.json"), NO_FILES)).toEqual({ kind: "none", hint: "sdd-new" })
    expect(parseSddStatus(fixture("sdd-pricing-service-default.json"), NO_FILES)).toEqual({ kind: "none", hint: "sdd-new" })
  })

  test("homelab with several changes: none with the select-change hint", () => {
    expect(parseSddStatus(fixture("sdd-homelab-default.json"), NO_FILES)).toEqual({ kind: "none", hint: "select-change" })
    expect(parseSddStatus(fixture("sdd-synth-default.json"), NO_FILES)).toEqual({ kind: "none", hint: "select-change" })
  })

  test("nonexistent change: none, not an empty change", () => {
    expect(parseSddStatus(fixture("sdd-venue-finder-nonexistent-change.json"), NO_FILES)).toEqual({ kind: "none", hint: "sdd-new" })
  })
})

describe("phases, «estás aquí» and «siguiente»", () => {
  const cases: [string, Partial<SddChange["phases"]>, SddChange["current"], SddChange["next"]][] = [
    ["sdd-synth-c1-proposal-only.json", { explore: "done", propose: "done", spec: "todo", apply: "todo" }, "propose", "spec"],
    ["sdd-synth-c2-specs.json", { spec: "done", design: "todo" }, "spec", "design"],
    ["sdd-synth-c3-design.json", { design: "done", tasks: "todo" }, "design", "tasks"],
    ["sdd-synth-c4-tasks-zero.json", { tasks: "done", apply: "todo" }, "tasks", "apply"],
    ["sdd-synth-c5-tasks-partial.json", { tasks: "done", apply: "active" }, "apply", "apply"],
    ["sdd-synth-c6-all-done-no-progress.json", { apply: "done", verify: "todo" }, "apply", "archive"],
    ["sdd-synth-c7-progress.json", { apply: "done", verify: "todo" }, "apply", "archive"],
    ["sdd-synth-c8-verified.json", { apply: "done", verify: "done", archive: "todo" }, "verify", "archive"],
    ["sdd-synth-c9-tasks-only.json", { propose: "todo", spec: "todo", design: "todo", tasks: "done", apply: "blocked" }, "apply", "propose"],
    ["sdd-homelab-deploy-agent-rpi.json", { apply: "done", verify: "todo", archive: "todo" }, "apply", "archive"],
    ["sdd-homelab-uptime-diagnostics.json", { apply: "done" }, "apply", "archive"],
  ]
  for (const [file, phases, current, next] of cases) {
    test(file, () => {
      const c = asChange(parseSddStatus(fixture(file), NO_FILES))
      expect(c.phases).toMatchObject(phases)
      expect(c.phases.archive).toBe("todo")
      expect(c.current).toBe(current)
      expect(c.next).toBe(next)
      expect(c.store).toBe("openspec")
    })
  }

  test("c5: apply half done with its progress", () => {
    const c = asChange(parseSddStatus(fixture("sdd-synth-c5-tasks-partial.json"), NO_FILES))
    expect(c.name).toBe("c5-tasks-partial")
    expect(c.tasks).toEqual({ total: 16, completed: 6, pending: 10 })
    expect(c.blocked).toEqual([])
    expect(c.nextRecommended).toBe("apply")
  })

  test("deploy-agent: all done, next archive", () => {
    const c = asChange(parseSddStatus(fixture("sdd-homelab-deploy-agent-rpi.json"), NO_FILES))
    expect(c.phases).toEqual({
      explore: "done",
      propose: "done",
      spec: "done",
      design: "done",
      tasks: "done",
      apply: "done",
      verify: "todo",
      archive: "todo",
    })
    expect(c.nextRecommended).toBe("archive")
  })

  test("venue-finder: apply blocked with the inferred reason", () => {
    const c = asChange(parseSddStatus(fixture("sdd-venue-finder-find-alternative-venue.json"), NO_FILES))
    expect(c.phases).toMatchObject({ propose: "done", spec: "todo", design: "todo", tasks: "done", apply: "blocked" })
    expect(c.current).toBe("apply")
    expect(c.next).toBe("spec")
    expect(c.tasks).toEqual({ total: 15, completed: 4, pending: 11 })
    expect(c.blocked).toEqual(["apply bloqueado: faltan spec y design"])
  })

  test("c9: the three previous phases are missing", () => {
    const c = asChange(parseSddStatus(fixture("sdd-synth-c9-tasks-only.json"), NO_FILES))
    expect(c.blocked).toEqual(["apply bloqueado: faltan proposal, spec y design"])
  })

  test("nextRecommended that is not a phase: kept as is, without next", () => {
    const j = fixture("sdd-synth-c5-tasks-partial.json")
    j.nextRecommended = "sdd-continue"
    const c = asChange(parseSddStatus(j, NO_FILES))
    expect(c.next).toBeUndefined()
    expect(c.nextRecommended).toBe("sdd-continue")
  })

  test("blockedReasons without the «Run `gentle-ai sdd-status …`» hints", () => {
    const j = fixture("sdd-synth-c5-tasks-partial.json")
    j.blockedReasons = ["Algo bloquea.", "Run `gentle-ai sdd-status x --cwd /p` to continue with x."]
    expect(asChange(parseSddStatus(j, NO_FILES)).blocked).toEqual(["Algo bloquea."])
  })

  test("tasks and notes from the JSON", () => {
    const j = fixture("sdd-synth-c5-tasks-partial.json")
    j.notes = ["una nota"]
    expect(asChange(parseSddStatus(j, NO_FILES)).notes).toEqual(["una nota"])
  })
})

describe("current task from tasks.md", () => {
  const md = ["# Tasks", "", "## 1. Base", "- [x] 1.1 Hecha", "", "## 2. Resto", "- [x] 2.1 Otra", "-   [ ]   2.3 Configurar   el servicio  ", "- [ ] 2.4 Después"].join("\n")

  test("the first unchecked one, on one line and with its id", () => {
    expect(firstOpenTask(md)).toBe("2.3 Configurar el servicio")
    const c = asChange(parseSddStatus(fixture("sdd-synth-c5-tasks-partial.json"), { mtimes: {}, tasksMd: md }))
    expect(c.currentTask).toBe("2.3 Configurar el servicio")
  })

  test("no pending tasks or no file: no current task", () => {
    expect(firstOpenTask("- [x] 1 hecha")).toBeUndefined()
    expect(firstOpenTask(undefined)).toBeUndefined()
    expect(asChange(parseSddStatus(fixture("sdd-synth-c5-tasks-partial.json"), NO_FILES)).currentTask).toBeUndefined()
  })
})

describe("incoherent or unsupported JSON", () => {
  test("not an object", () => {
    expect(parseSddStatus(null, NO_FILES).kind).toBe("incoherent")
    expect(parseSddStatus([1, 2], NO_FILES).kind).toBe("incoherent")
    expect(parseSddStatus("texto", NO_FILES).kind).toBe("incoherent")
  })

  test("another schema or version", () => {
    const j = fixture("sdd-synth-c5-tasks-partial.json")
    expect(parseSddStatus({ ...j, schemaVersion: 3 }, NO_FILES)).toEqual({ kind: "unsupported", schema: "gentle-ai.sdd-status@3" })
    expect(parseSddStatus({ ...j, schemaName: "otro" }, NO_FILES)).toEqual({ kind: "unsupported", schema: "otro@2" })
  })

  test("missing fields", () => {
    const j = fixture("sdd-synth-c5-tasks-partial.json")
    delete j.artifacts
    delete j.taskProgress
    const s = parseSddStatus(j, NO_FILES)
    expect(s.kind).toBe("incoherent")
    if (s.kind === "incoherent") expect(s.reasons).toEqual(["falta artifacts", "taskProgress incompleto"])
  })

  test("artifact done without files in openspec (wrong store)", () => {
    const j = fixture("sdd-synth-c3-design.json")
    j.artifactPaths.design = []
    const s = parseSddStatus(j, NO_FILES)
    expect(s).toEqual({ kind: "incoherent", reasons: ["design figura como hecho pero no tiene ficheros en openspec"] })
  })

  test("file paths with a store that is not openspec", () => {
    const j = fixture("sdd-synth-c3-design.json")
    j.artifactStore = "engram"
    const s = parseSddStatus(j, NO_FILES)
    expect(s).toEqual({ kind: "incoherent", reasons: ["el store es engram pero hay rutas de fichero"] })
  })

  test("more completed than tasks, or negative", () => {
    const j = fixture("sdd-synth-c5-tasks-partial.json")
    j.taskProgress = { total: 3, completed: 5, pending: -2, allComplete: false }
    const s = parseSddStatus(j, NO_FILES)
    expect(s.kind).toBe("incoherent")
    if (s.kind === "incoherent") {
      expect(s.reasons).toContain("taskProgress tiene valores negativos")
      expect(s.reasons).toContain("hay más tareas completadas (5) que tareas (3)")
    }
  })

  test("no change but with done artifacts", () => {
    const j = fixture("sdd-synth-c1-proposal-only.json")
    j.changeName = null
    const s = parseSddStatus(j, NO_FILES)
    expect(s).toEqual({ kind: "incoherent", reasons: ["no hay cambio activo pero hay artefactos hechos"] })
  })

  test("change only in Engram: shown, without drift available", () => {
    const j = fixture("sdd-synth-c1-proposal-only.json")
    j.artifactStore = "engram"
    j.changeRoot = null
    for (const k of Object.keys(j.artifactPaths)) j.artifactPaths[k] = []
    const c = asChange(parseSddStatus(j, NO_FILES))
    expect(c.store).toBe("engram")
    expect(c.phases.propose).toBe("done")
    expect(c.stale).toBe("unavailable")
  })
})

describe("artifact date per phase", () => {
  const j = fixture("sdd-synth-c5-tasks-partial.json")
  const [spec] = j.artifactPaths.specs as string[]
  const [tasks] = j.artifactPaths.tasks as string[]
  const [proposal] = j.artifactPaths.proposal as string[]

  test("each artifact to its phase; tasks.md with checked tasks also counts for apply", () => {
    const c = asChange(parseSddStatus(j, { mtimes: { [proposal!]: 1_000, [spec!]: 2_000, [tasks!]: 3_000 } }))
    expect(c.tasks.completed).toBeGreaterThan(0)
    expect(c.phaseUpdatedAt).toEqual({ propose: 1_000, spec: 2_000, tasks: 3_000, apply: 3_000 })
  })

  test("without checked tasks, tasks.md does not count for apply", () => {
    const k = fixture("sdd-synth-c5-tasks-partial.json")
    k.taskProgress = { total: 16, completed: 0, pending: 16, allComplete: false }
    expect(asChange(parseSddStatus(k, { mtimes: { [tasks!]: 3_000 } })).phaseUpdatedAt).toEqual({ tasks: 3_000 })
  })

  test("no mtimes: none", () => {
    expect(asChange(parseSddStatus(j, NO_FILES)).phaseUpdatedAt).toBeUndefined()
  })
})

describe("drift by mtime", () => {
  const j = fixture("sdd-synth-c5-tasks-partial.json")
  const [spec] = j.artifactPaths.specs as string[]
  const [tasks] = j.artifactPaths.tasks as string[]
  const [proposal] = j.artifactPaths.proposal as string[]
  const MIN = 60_000

  test("spec newer than tasks: warning", () => {
    const c = asChange(parseSddStatus(j, { mtimes: { [spec!]: 20 * MIN, [tasks!]: 5 * MIN, [proposal!]: 1 * MIN } }))
    expect(c.stale).toEqual([
      { upstream: "specs", downstream: "tasks", upstreamFile: spec!, upstreamMtime: 20 * MIN, downstreamFile: tasks!, downstreamMtime: 5 * MIN },
    ])
  })

  test("within the 5 min margin: no warning", () => {
    const c = asChange(parseSddStatus(j, { mtimes: { [spec!]: 5 * MIN + STALE_TOLERANCE_MS, [tasks!]: 5 * MIN } }))
    expect(c.stale).toEqual([])
  })

  test("no mtimes: no warning and no error", () => {
    expect(asChange(parseSddStatus(j, NO_FILES)).stale).toEqual([])
  })

  test("specs uses the newest of its files", () => {
    const k = fixture("sdd-synth-c5-tasks-partial.json")
    const other = spec!.replace("status-agent", "otra")
    k.artifactPaths.specs = [spec, other]
    const c = asChange(parseSddStatus(k, { mtimes: { [spec!]: 1 * MIN, [other]: 20 * MIN, [tasks!]: 5 * MIN } }))
    expect(c.stale).toMatchObject([{ upstream: "specs", upstreamFile: other, upstreamMtime: 20 * MIN }])
  })
})

// ── Reader with real files in a temporary directory ────────────────────────

function write(path: string, text: string, mtimeSec: number) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  utimesSync(path, mtimeSec, mtimeSec)
}

/** Rewrites the synthetic fixture paths (from a scratch dir long gone) to `root`. */
function relocate(file: string, root: string): string {
  const j = fixture(file)
  const from = (j.planningHome.path as string).replace(/\/openspec$/, "")
  return raw(file).split(from).join(root)
}

describe("loadSdd", () => {
  test("reads mtimes and tasks.md: spec newer than tasks → warning", async () => {
    const root = join(tmp, "stale")
    const change = join(root, "openspec", "changes", "c5-tasks-partial")
    write(join(change, "proposal.md"), "# p", 1_000)
    write(join(change, "design.md"), "# d", 1_000)
    write(join(change, "tasks.md"), "- [x] 1.1 a\n- [ ] 1.2 Siguiente tarea\n", 2_000)
    write(join(change, "specs", "status-agent", "spec.md"), "# s", 3_000)
    const out = relocate("sdd-synth-c5-tasks-partial.json", root)
    const run: Run = async () => out
    const c = asChange(await loadSdd(root, run))
    expect(c.currentTask).toBe("1.2 Siguiente tarea")
    expect(c.stale).toEqual([
      {
        upstream: "specs",
        downstream: "tasks",
        upstreamFile: join(change, "specs", "status-agent", "spec.md"),
        upstreamMtime: 3_000_000,
        downstreamFile: join(change, "tasks.md"),
        downstreamMtime: 2_000_000,
      },
    ])
    // The same dates, per phase (for the sidebar's phase in progress).
    expect(c.phaseUpdatedAt).toEqual({ propose: 1_000_000, spec: 3_000_000, design: 1_000_000, tasks: 2_000_000, apply: 2_000_000 })
  })

  test("same agent pass (design 17 s after tasks): no warning", async () => {
    const root = join(tmp, "pass")
    const change = join(root, "openspec", "changes", "c5-tasks-partial")
    write(join(change, "proposal.md"), "# p", 2_000)
    write(join(change, "tasks.md"), "- [ ] 1.1 a\n", 2_000)
    write(join(change, "design.md"), "# d", 2_017)
    write(join(change, "specs", "status-agent", "spec.md"), "# s", 2_000)
    const out = relocate("sdd-synth-c5-tasks-partial.json", root)
    expect(asChange(await loadSdd(root, async () => out)).stale).toEqual([])
  })

  test("after 5 minutes it does warn (6 min)", async () => {
    const root = join(tmp, "later")
    const change = join(root, "openspec", "changes", "c5-tasks-partial")
    write(join(change, "proposal.md"), "# p", 2_000)
    write(join(change, "tasks.md"), "- [ ] 1.1 a\n", 2_000)
    write(join(change, "design.md"), "# d", 2_360)
    write(join(change, "specs", "status-agent", "spec.md"), "# s", 2_000)
    const out = relocate("sdd-synth-c5-tasks-partial.json", root)
    const stale = asChange(await loadSdd(root, async () => out)).stale
    expect(Array.isArray(stale) && stale.map((w) => `${w.upstream}>${w.downstream}`)).toEqual(["design>tasks"])
  })

  test("files saved less than 2 s apart: no warning", async () => {
    const root = join(tmp, "fresh")
    const change = join(root, "openspec", "changes", "c5-tasks-partial")
    write(join(change, "proposal.md"), "# p", 1_000)
    write(join(change, "design.md"), "# d", 1_000)
    write(join(change, "tasks.md"), "- [ ] 1.1 a\n", 2_000)
    write(join(change, "specs", "status-agent", "spec.md"), "# s", 2_001)
    const out = relocate("sdd-synth-c5-tasks-partial.json", root)
    expect(asChange(await loadSdd(root, async () => out)).stale).toEqual([])
  })

  test("fixture paths that no longer exist: no warning and no error", async () => {
    const out = relocate("sdd-synth-c8-verified.json", join(tmp, "nada"))
    const c = asChange(await loadSdd(join(tmp, "nada"), async () => out))
    expect(c.stale).toEqual([])
    expect(c.currentTask).toBeUndefined()
  })

  test("select-change: picks the newest change and counts the others", async () => {
    const root = join(tmp, "multi")
    const changes = join(root, "openspec", "changes")
    write(join(changes, "viejo", "proposal.md"), "# v", 1_000)
    write(join(changes, "nuevo", "proposal.md"), "# n", 1_000)
    write(join(changes, "nuevo", "specs", "x", "spec.md"), "# s", 9_000)
    write(join(changes, "medio", "tasks.md"), "- [ ] t", 5_000)
    write(join(changes, "archive", "2026-01-01-antiguo", "proposal.md"), "# a", 99_000)
    const calls: string[][] = []
    const run: Run = async (cmd, args) => {
      expect(cmd).toBe("gentle-ai")
      calls.push(args)
      return args.length === 4 ? raw("sdd-synth-default.json") : raw("sdd-synth-c1-proposal-only.json")
    }
    const c = asChange(await loadSdd(root, run))
    expect(calls).toEqual([sddStatusArgs(root), sddStatusArgs(root, "nuevo")])
    expect(c.choice).toEqual({ index: 1, total: 3, others: ["medio", "viejo"], reason: "recent" })
    expect(c.name).toBe("c1-proposal-only")
  })

  test("select-change: a folder named like an option is neither queried nor stalls the poll", async () => {
    const root = join(tmp, "opcion")
    const changes = join(root, "openspec", "changes")
    write(join(changes, "--help", "proposal.md"), "# h", 9_000)
    write(join(changes, "start", "proposal.md"), "# s", 8_000)
    write(join(changes, "bueno", "proposal.md"), "# b", 1_000)
    expect(await activeChanges(root)).toEqual(["bueno"])
    const calls: string[][] = []
    const run: Run = async (_cmd, args) => (calls.push(args), args.length === 4 ? raw("sdd-synth-default.json") : raw("sdd-synth-c1-proposal-only.json"))
    const c = asChange(await loadSdd(root, run))
    expect(calls).toEqual([sddStatusArgs(root), sddStatusArgs(root, "bueno")])
    expect(c.choice).toEqual({ index: 1, total: 1, others: [], reason: "recent" })
  })

  test("select-change: the branch's change or the pinned one, with the reason in choice", async () => {
    const root = join(tmp, "rama")
    const changes = join(root, "openspec", "changes")
    write(join(changes, "nuevo", "proposal.md"), "# n", 9_000)
    write(join(changes, "medio", "proposal.md"), "# m", 5_000)
    write(join(changes, "viejo", "proposal.md"), "# v", 1_000)
    write(join(changes, "viejo", ".openspec.yaml"), "workItem: AB#1187\n", 1_000)
    write(join(root, ".git", "config"), '[remote "origin"]\n\turl = https://dev.azure.com/o/p/_git/r\n', 1_000)
    const asked: string[] = []
    const run: Run = async (_cmd, args) => (args.length === 4 ? raw("sdd-synth-default.json") : (asked.push(args[1]!), raw("sdd-synth-c1-proposal-only.json")))
    const load = async (branch: string, pin?: Pin) => {
      write(join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`, 1_000)
      asked.length = 0
      const c = asChange(await loadSdd(root, run, nodeFs, pin ? { pin: () => pin } : {}))
      return { asked: asked[0], choice: c.choice, pinned: c.pinned === true }
    }
    expect(await load("feat/medio")).toEqual({ asked: "medio", choice: { index: 1, total: 3, others: ["nuevo", "viejo"], reason: "branch" }, pinned: false })
    expect(await load("feature/1187-otra-cosa")).toMatchObject({ asked: "viejo", choice: { reason: "branch" } })
    expect(await load("main")).toMatchObject({ asked: "nuevo", choice: { reason: "recent" } })
    expect(await load("feat/medio")).toMatchObject({ pinned: false })
    expect(await load("feat/medio", { kind: "sdd", name: "viejo", branch: "feat/medio" })).toMatchObject({ asked: "viejo", choice: { reason: "pinned", others: ["nuevo", "medio"] }, pinned: true })
    // Pinned on another branch or to an ODD feature: does not count.
    expect(await load("feat/medio", { kind: "sdd", name: "viejo", branch: "main" })).toMatchObject({ asked: "medio", choice: { reason: "branch" }, pinned: false })
    expect(await load("feat/medio", { kind: "odd", name: "viejo", branch: "feat/medio" })).toMatchObject({ asked: "medio", choice: { reason: "branch" }, pinned: false })
  })

  test("a single pinned change (no select-change): pinned only on its branch", async () => {
    const root = join(tmp, "uno-fijado")
    write(join(root, ".git", "HEAD"), "ref: refs/heads/feat/x\n", 1_000)
    const run: Run = async () => raw("sdd-synth-c1-proposal-only.json")
    const load = async (pin?: Pin) => asChange(await loadSdd(root, run, nodeFs, pin ? { pin: () => pin } : {}))
    expect((await load()).pinned).toBeUndefined()
    const c = await load({ kind: "sdd", name: "c1-proposal-only", branch: "feat/x" })
    expect(c.pinned).toBe(true)
    expect(c.choice).toBeUndefined()
    expect((await load({ kind: "sdd", name: "c1-proposal-only", branch: "main" })).pinned).toBeUndefined()
    expect((await load({ kind: "sdd", name: "otro", branch: "feat/x" })).pinned).toBeUndefined()
    expect((await load({ kind: "odd", name: "c1-proposal-only", branch: "feat/x" })).pinned).toBeUndefined()
  })

  test("pinned as new (origin new): pinnedNew, with one or several changes; by hand, not", async () => {
    const one = join(tmp, "uno-nuevo")
    write(join(one, ".git", "HEAD"), "ref: refs/heads/feat/x\n", 1_000)
    const single: Run = async () => raw("sdd-synth-c1-proposal-only.json")
    const loadOne = async (pin: Pin) => asChange(await loadSdd(one, single, nodeFs, { pin: () => pin }))
    expect(await loadOne({ kind: "sdd", name: "c1-proposal-only", branch: "feat/x", origin: "new" })).toMatchObject({ pinned: true, pinnedNew: true })
    expect((await loadOne({ kind: "sdd", name: "c1-proposal-only", branch: "feat/x" })).pinnedNew).toBeUndefined()
    expect((await loadOne({ kind: "sdd", name: "c1-proposal-only", branch: "main", origin: "new" })).pinnedNew).toBeUndefined()

    const many = join(tmp, "varios-nuevo")
    write(join(many, "openspec", "changes", "prueba-nueva", "proposal.md"), "# n", 9_000)
    write(join(many, "openspec", "changes", "viejo", "proposal.md"), "# v", 1_000)
    write(join(many, ".git", "HEAD"), "ref: refs/heads/main\n", 1_000)
    const asked: string[] = []
    const run: Run = async (_cmd, args) => (args.length === 4 ? raw("sdd-synth-default.json") : (asked.push(args[1]!), raw("sdd-synth-c1-proposal-only.json")))
    const c = asChange(await loadSdd(many, run, nodeFs, { pin: () => ({ kind: "sdd", name: "viejo", branch: "main", origin: "new" }) }))
    expect(asked).toEqual(["viejo"])
    expect(c).toMatchObject({ pinned: true, pinnedNew: true, choice: { reason: "pinned" } })
  })

  test("select-change with the list already read (changes): does not list again", async () => {
    const root = join(tmp, "lista-dada")
    write(join(root, "openspec", "changes", "en-disco", "proposal.md"), "# d", 1_000)
    const asked: string[] = []
    const run: Run = async (_cmd, args) => (args.length === 4 ? raw("sdd-synth-default.json") : (asked.push(args[1]!), raw("sdd-synth-c1-proposal-only.json")))
    const c = asChange(await loadSdd(root, run, nodeFs, { changes: [{ name: "dado", mtime: 5_000 }] }))
    expect(asked).toEqual(["dado"])
    expect(c.choice).toMatchObject({ total: 1, others: [] })
  })

  test("select-change: branchMatch if it is the branch's (by work item or name) and updatedAt from its folder", async () => {
    const root = join(tmp, "rama-motivo")
    const changes = join(root, "openspec", "changes")
    write(join(changes, "nuevo", "proposal.md"), "# n", 9_000)
    write(join(changes, "medio", "proposal.md"), "# m", 5_000)
    write(join(changes, "viejo", "proposal.md"), "# v", 1_000)
    write(join(changes, "viejo", ".openspec.yaml"), "workItem: AB#1187\n", 1_000)
    write(join(root, ".git", "config"), '[remote "origin"]\n\turl = https://dev.azure.com/o/p/_git/r\n', 1_000)
    const run: Run = async (_cmd, args) => (args.length === 4 ? raw("sdd-synth-default.json") : raw("sdd-synth-c1-proposal-only.json"))
    const load = async (branch: string, pin?: Pin) => {
      write(join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`, 1_000)
      const c = asChange(await loadSdd(root, run, nodeFs, pin ? { pin: () => pin } : {}))
      return { branchMatch: c.branchMatch, updatedAt: c.updatedAt }
    }
    expect(await load("feat/medio")).toEqual({ branchMatch: { by: "name", length: 5 }, updatedAt: 5_000_000 })
    expect(await load("feature/1187-otra-cosa")).toEqual({ branchMatch: { by: "workItem", length: 5 }, updatedAt: 1_000_000 })
    expect(await load("main")).toEqual({ branchMatch: undefined, updatedAt: 9_000_000 })
    // Pinned: the pin wins; the branch reason is not needed.
    expect(await load("feat/medio", { kind: "sdd", name: "viejo", branch: "feat/medio" })).toEqual({ branchMatch: undefined, updatedAt: 1_000_000 })
  })

  test("a single change (no select-change): branchMatch if it matches the branch; updatedAt from its artifacts", async () => {
    const root = join(tmp, "uno-rama")
    const change = join(root, "openspec", "changes", "c1-proposal-only")
    write(join(change, "proposal.md"), "# p", 4_000)
    write(join(root, ".git", "config"), '[remote "origin"]\n\turl = https://dev.azure.com/o/p/_git/r\n', 1_000)
    const out = relocate("sdd-synth-c1-proposal-only.json", root)
    const load = async (branch: string) => {
      write(join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`, 1_000)
      return asChange(await loadSdd(root, async () => out))
    }
    expect((await load("feat/c1-proposal-only")).branchMatch).toEqual({ by: "name", length: 16 })
    const other = await load("main")
    expect(other.branchMatch).toBeUndefined()
    expect(other.updatedAt).toBe(4_000_000)
    write(join(change, ".openspec.yaml"), "workItem: AB#1187\n", 1_000)
    expect((await load("feature/1187-otra-cosa")).branchMatch).toEqual({ by: "workItem", length: 16 })
    // No artifacts inside the root (e.g. Engram): no date, nothing made up.
    expect(asChange(await loadSdd(root, async () => raw("sdd-synth-c1-proposal-only.json"))).updatedAt).toBeUndefined()
  })

  test("paths outside the root or links leaving it: neither mtime nor tasks.md", async () => {
    const root = join(tmp, "contencion")
    const change = join(root, "openspec", "changes", "c")
    write(join(tmp, "fuera-tasks.md"), "- [ ] secreto de fuera", 1_000)
    mkdirSync(change, { recursive: true })
    symlinkSync(join(tmp, "fuera-tasks.md"), join(change, "tasks.md"))
    write(join(change, "proposal.md"), "# p", 2_000)
    const touched: string[] = []
    const spy: Fsx = { ...nodeFs, readText: (p, o) => (touched.push(p), nodeFs.readText(p, o)), mtime: (p) => (touched.push(p), nodeFs.mtime(p)) }
    const json = { artifactPaths: { proposal: [join(change, "proposal.md")], specs: ["/etc/hosts"], tasks: [join(change, "tasks.md")] } }
    const files = await readSddFiles(json, root, spy)
    expect(files).toEqual({ mtimes: { [join(change, "proposal.md")]: 2_000_000 } })
    expect(touched).toEqual([join(change, "proposal.md")])
  })

  test("select-change without change folders: none", async () => {
    const run: Run = async () => raw("sdd-homelab-default.json")
    expect(await loadSdd(join(tmp, "vacio"), run)).toEqual({ kind: "none", hint: "select-change" })
  })

  test("output that is not JSON: incoherent", async () => {
    const s = await loadSdd(tmp, async () => "Error: algo")
    expect(s.kind).toBe("incoherent")
  })

  test("if run fails, it throws", async () => {
    const run: Run = async () => {
      throw new Error("timeout")
    }
    await expect(loadSdd(tmp, run)).rejects.toThrow("timeout")
  })
})
