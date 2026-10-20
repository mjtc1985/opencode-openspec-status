import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OddFeature } from "../../src/model.ts"
import type { Pin } from "../../src/sources/choice.ts"
import { type Fsx, nodeFs } from "../../src/sources/exec.ts"
import { createOddListLoader, listOddDocs, listOddFeatures, loadOdd, oddDocName, parseOddDoc, stripRouteNotes } from "../../src/sources/odd.ts"

const FIX = join(import.meta.dir, "..", "fixtures")
const doc = (name: string) => parseOddDoc(readFileSync(join(FIX, name), "utf8"), `odd/tasks/${name}`)
const ids = (f: OddFeature) => f.tasks.map((t) => t.id)

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-odd-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe("ODD documents", () => {
  test("sample-app: title without «Feature:», document order and T7 in progress via «(partial)»", () => {
    const f = doc("odd-sample-app-skeleton.md")
    expect(f.title).toBe("sample-app-skeleton")
    expect(ids(f)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T8", "T9", "T7"])
    expect(f.tasks.filter((t) => t.status === "done").map((t) => t.id)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"])
    expect(f.current?.id).toBe("T7")
    expect(f.current?.status).toBe("active")
    expect(f.current?.title).toBe("End-to-end check: sample project, init command, open the TUI, walk the four phases")
    expect(f.tasks.find((t) => t.id === "T8")?.status).toBe("todo")
    expect(f.allDone).toBe(false)
    expect(f.warnings).toEqual([])
    expect(f.nextStep).toBe(
      "User runs the interactive TUI check; then reduce exploration friction in the agent (new task).",
    )
  })

  test("sample-app: «Route: …» notes do not reach the title", () => {
    const f = doc("odd-sample-app-skeleton.md")
    expect(f.tasks[0]!.title).toBe("Scaffold: root commit, feature branch, package.json, tsconfig, .gitignore, AGENTS.md (commands), README stub")
    for (const t of f.tasks) expect(t.title).not.toMatch(/route:/i)
  })

  test("web: hanging indent joined and «(route: …)» removed, all done", () => {
    const f = doc("odd-web-mobile-contact-bar.md")
    expect(f.title).toBe("Mobile contact bar and home hero CTA")
    expect(ids(f)).toEqual(["T1", "T2", "T3"])
    expect(f.tasks.map((t) => t.title.slice(0, 21))).toEqual(["Mobile contact bar", "Home hero CTA", "Record both changes i"])
    expect(f.tasks[2]!.title).toContain("(done inside the T1 and T2 commits, one entry each, so every commit carries its own record)")
    expect(f.allDone).toBe(true)
    expect(f.current).toBeUndefined()
    expect(f.nextStep).toBe(
      "Measure after one full week: chat_contact and phone_contact by link_id bar_chat / bar_call, and home contact rate. Push and merge of feat/mobile-contact-bar are the owner's decision.",
    )
  })

  test("homelab: Spanish document with «Tareas», «Ruta:» and «Siguiente paso»", () => {
    const f = doc("odd-homelab-floor-plan-es.md")
    expect(f.title).toBe("Plano de la casa (dashboard `/map`)")
    expect(ids(f)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7"])
    expect(f.tasks[0]!.title).toBe(
      "Plano rectilíneo `www/floorplan/plano.svg` + `plano.css`, generado por `floorplan/generate_plan.py`",
    )
    expect(f.allDone).toBe(true)
    expect(f.nextStep).toStartWith("El usuario comprueba `/map/plano`")
  })
})

describe("markdown variations", () => {
  const md = [
    "# Mi feature",
    "",
    "## Tareas",
    "* [X] T2 Segunda hecha",
    "- [ ] T10 Décima pendiente",
    "- [ ] T3 Tercera (ruta: inline (mecánico); sin delegar)",
    "  con continuación",
    "- [ ] Sin id",
    "- [x] T2 Repetida",
    "",
    "```",
    "- [ ] T99 dentro de un bloque de código",
    "```",
    "",
    "## Próximo paso",
    "",
    "Hacer la T3",
    "en dos líneas.",
    "",
    "Otro párrafo que no cuenta.",
  ].join("\n")

  test("checkboxes with * and [X], ids, nested route notes and warnings", () => {
    const f = parseOddDoc(md, "odd/tasks/mi.md")
    expect(f.title).toBe("Mi feature")
    expect(ids(f)).toEqual(["T2", "T10", "T3", "#4", "T2"])
    expect(f.tasks[2]!.title).toBe("Tercera con continuación")
    expect(f.tasks[3]!.title).toBe("Sin id")
    expect(f.warnings).toEqual(["1 tarea sin id", "ids duplicados: T2"])
    expect(f.nextStep).toBe("Hacer la T3 en dos líneas.")
  })

  test("no «in progress» mark: the pending one with the lowest id", () => {
    const f = parseOddDoc(md, "odd/tasks/mi.md")
    expect(f.current?.id).toBe("T3")
    expect(f.tasks.filter((t) => t.status === "active")).toHaveLength(1)
  })

  test("Spanish «(parcial)» mark and «◉»", () => {
    const a = parseOddDoc("## Tareas\n- [ ] T1 Una\n- [ ] T2 (parcial) Dos\n", "a.md")
    expect(a.current).toEqual({ id: "T2", title: "Dos", status: "active" })
    const b = parseOddDoc("## Tasks\n- [ ] T1 One\n- [ ] T2 ◉ Two\n", "b.md")
    expect(b.current?.id).toBe("T2")
    expect(b.title).toBe("b")
  })

  test("no tasks section: any checkbox in the document", () => {
    const f = parseOddDoc("# X\n\n## Plan\n- [x] T1 a\n- [ ] T2 b\n", "x.md")
    expect(ids(f)).toEqual(["T1", "T2"])
    expect(f.current?.id).toBe("T2")
  })

  test("broken or empty markdown does not throw", () => {
    for (const bad of ["", "```\n- [ ] T1 sin cerrar", "## Tasks\n- [ ]\n- [x]", "#\n##\n- [", "\u0000\u0001"]) {
      const f = parseOddDoc(bad, "odd/tasks/roto.md")
      expect(f.kind).toBe("feature")
      expect(Array.isArray(f.warnings)).toBe(true)
    }
    const empty = parseOddDoc("", "odd/tasks/roto.md")
    expect(empty.title).toBe("roto")
    expect(empty.tasks).toEqual([])
    expect(empty.allDone).toBe(false)
    expect(empty.warnings).toEqual(["no se encontraron tareas"])
    expect(parseOddDoc(undefined as unknown as string, "z.md").tasks).toEqual([])
  })

  test("stripRouteNotes does not cut a «ruta:» in the middle of a sentence", () => {
    expect(stripRouteNotes("Cambiar la ruta: /api")).toBe("Cambiar la ruta: /api")
    expect(stripRouteNotes("Hecho. Route: inline (x). Status: y")).toBe("Hecho")
    expect(stripRouteNotes("A (route: inline; b (c)) y más")).toBe("A y más")
  })
})

function write(root: string, name: string, text: string, mtimeSec: number) {
  const dir = join(root, "odd", "tasks")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
  utimesSync(join(dir, name), mtimeSec, mtimeSec)
}

const head = (root: string, branch: string) => {
  mkdirSync(join(root, ".git"), { recursive: true })
  writeFileSync(join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`)
}

describe("loadOdd", () => {
  test("no folder: none", async () => {
    expect(await loadOdd(join(tmp, "nada"))).toEqual({ kind: "none" })
  })

  test("the newest with pending tasks, with a relative path", async () => {
    const root = join(tmp, "p")
    write(root, "vieja.md", "# Vieja\n## Tasks\n- [ ] T1 pendiente\n", 1_000)
    write(root, "media.md", "# Media\n## Tasks\n- [ ] T1 pendiente\n", 2_000)
    write(root, "nueva-hecha.md", "# Nueva\n## Tasks\n- [x] T1 hecha\n", 3_000)
    writeFileSync(join(root, "odd", "tasks", "notas.txt"), "- [ ] T1 no es md")
    const f = await loadOdd(root)
    expect(f.kind).toBe("feature")
    if (f.kind === "feature") {
      expect(f.title).toBe("Media")
      expect(f.file).toBe("odd/tasks/media.md")
    }
  })

  test("committed FIFO and link to /dev/zero: skipped without blocking or reading", async () => {
    const root = join(tmp, "hostil")
    write(root, "buena.md", "# Buena\n## Tasks\n- [ ] T1 pendiente\n", 1_000)
    const dir = join(root, "odd", "tasks")
    expect(spawnSync("mkfifo", [join(dir, "fifo.md")]).status).toBe(0)
    symlinkSync("/dev/zero", join(dir, "zero.md"))
    const timeout = new Promise((resolve) => setTimeout(() => resolve("bloqueado"), 1_000))
    const f = await Promise.race([loadOdd(root), timeout])
    expect(f).toMatchObject({ kind: "feature", file: "odd/tasks/buena.md" })
  })

  test("the branch's feature beats the newest if it has pending tasks", async () => {
    const root = join(tmp, "rama")
    write(root, "gentle-flow.md", "# Gentle\n## Tasks\n- [ ] T1 pendiente\n", 1_000)
    write(root, "flow.md", "# Flow\n## Tasks\n- [ ] T1 pendiente\n", 1_500)
    write(root, "otra.md", "# Otra\n## Tasks\n- [ ] T1 pendiente\n", 2_000)
    write(root, "hecha.md", "# Hecha\n## Tasks\n- [x] T1 hecha\n", 3_000)
    mkdirSync(join(root, ".git"), { recursive: true })
    const head = (branch: string) => writeFileSync(join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`)
    const file = async () => ((await loadOdd(root)) as OddFeature).file
    head("feat/gentle-flow")
    // The branch contains both `gentle-flow` and `flow`: the longest name wins.
    expect(await file()).toBe("odd/tasks/gentle-flow.md")
    head("feat/cachear-flowchart")
    expect(await file()).toBe("odd/tasks/otra.md")
    // The branch's one has nothing pending: the newest with pending tasks.
    head("feat/hecha")
    expect(await file()).toBe("odd/tasks/otra.md")
    head("main")
    expect(await file()).toBe("odd/tasks/otra.md")
  })

  test("branchMatch only for the branch's one; updatedAt, the document's date", async () => {
    const root = join(tmp, "rama-motivo")
    write(root, "gentle-flow.md", "# Gentle\n## Tasks\n- [ ] T1 pendiente\n", 1_000)
    write(root, "otra.md", "# Otra\n## Tasks\n- [ ] T1 pendiente\n", 2_000)
    head(root, "feat/gentle-flow")
    expect(await loadOdd(root)).toMatchObject({ file: "odd/tasks/gentle-flow.md", branchMatch: { by: "name", length: 11 }, updatedAt: 1_000_000 })
    head(root, "main")
    const recent = (await loadOdd(root)) as OddFeature
    expect(recent.file).toBe("odd/tasks/otra.md")
    expect(recent.branchMatch).toBeUndefined()
    expect(recent.updatedAt).toBe(2_000_000)
  })

  test("a single document: the branch is checked too", async () => {
    const root = join(tmp, "uno-rama")
    write(root, "modo-oscuro.md", "# Modo\n## Tasks\n- [ ] T1 pendiente\n", 1_000)
    head(root, "feat/modo-oscuro")
    expect(((await loadOdd(root)) as OddFeature).branchMatch).toEqual({ by: "name", length: 11 })
  })

  test("all done: none", async () => {
    const root = join(tmp, "hecho")
    write(root, "a.md", "# A\n- [x] T1 hecha\n", 1_000)
    expect(await loadOdd(root)).toEqual({ kind: "none" })
  })
})

describe("loadOdd with a pinned feature", () => {
  const root = join(tmp, "fijada")
  write(root, "reciente.md", "# Reciente\n## Tasks\n- [ ] T1 pendiente\n", 3_000)
  write(root, "vieja.md", "# Vieja\n## Tasks\n- [x] T1 hecha\n- [ ] T2 pendiente\n", 1_000)
  write(root, "hecha.md", "# Hecha\n## Tasks\n- [x] T1 hecha\n", 2_000)
  writeFileSync(join(tmp, "fuera.md"), "# Fuera\n## Tasks\n- [ ] T1 secreto\n")
  symlinkSync(join(tmp, "fuera.md"), join(root, "odd", "tasks", "enlace.md"))
  head(root, "main")
  const load = (pin?: Pin) => loadOdd(root, undefined, pin ? { pin: () => pin } : {})
  const odd = (name: string, branch = "main"): Pin => ({ kind: "odd", name, branch })

  test("nothing pinned: the usual one, without pinned", async () => {
    expect(await load()).toMatchObject({ file: "odd/tasks/reciente.md" })
    expect(((await load()) as OddFeature).pinned).toBeUndefined()
  })

  test("the pinned one wins even if it is not the chosen one, and shows even when done", async () => {
    expect(await load(odd("vieja"))).toMatchObject({ file: "odd/tasks/vieja.md", pinned: true })
    expect(await load(odd("hecha"))).toMatchObject({ file: "odd/tasks/hecha.md", pinned: true, allDone: true })
  })

  test("from another branch, gone, SDD, unsafe or outside the folder: ignored", async () => {
    for (const pin of [odd("vieja", "feat/x"), odd("borrada"), { kind: "sdd", name: "vieja", branch: "main" } as Pin, odd("../vieja"), odd("enlace")]) {
      const f = (await load(pin)) as OddFeature
      expect(f.file, JSON.stringify(pin)).toBe("odd/tasks/reciente.md")
      expect(f.pinned).toBeUndefined()
    }
  })

  test("pinned as new (origin new): pinnedNew; by hand, not", async () => {
    expect(await load({ ...odd("vieja"), origin: "new" })).toMatchObject({ file: "odd/tasks/vieja.md", pinned: true, pinnedNew: true })
    expect(((await load(odd("vieja"))) as OddFeature).pinnedNew).toBeUndefined()
    expect(((await load({ ...odd("vieja", "feat/x"), origin: "new" })) as OddFeature).pinnedNew).toBeUndefined()
  })

  test("with the list already read (docs): it does not list again and the list is the given one", async () => {
    expect(await loadOdd(root, undefined, { docs: [] })).toEqual({ kind: "none" })
    const docs = await listOddDocs(root)
    // listOddDocs only lists: the link leaving the folder is filtered by its users (loadOdd, the poller).
    expect(docs.map(oddDocName).sort()).toEqual(["enlace", "hecha", "reciente", "vieja"])
    expect(await loadOdd(root, undefined, { docs: docs.filter((d) => d.name === "vieja.md") })).toMatchObject({ file: "odd/tasks/vieja.md" })
  })
})

describe("listOddFeatures", () => {
  test("pending first, then done, each group by date; with the branch and no links leaving", async () => {
    const root = join(tmp, "lista")
    write(root, "a.md", "# A\n## Tasks\n- [x] T1 hecha\n- [ ] T2 pendiente\n- [ ] T3 pendiente\n", 1_000)
    write(root, "b.md", "# B\n## Tasks\n- [x] T1 hecha\n", 4_000)
    write(root, "c.md", "# C\n## Tasks\n- [ ] T1 pendiente\n", 3_000)
    write(root, "d.md", "# D\n## Tasks\n- [x] T1 hecha\n", 2_000)
    symlinkSync(join(tmp, "fuera.md"), join(root, "odd", "tasks", "enlace.md"))
    head(root, "feat/a")
    const list = await listOddFeatures(root)
    expect(list.branch).toBe("feat/a")
    expect(list.features.map((f) => f.name)).toEqual(["c", "a", "b", "d"])
    expect(list.features[1]).toEqual({ name: "a", file: "odd/tasks/a.md", title: "A", total: 3, done: 1, current: "T2", allDone: false })
    expect(list.features[2]).toEqual({ name: "b", file: "odd/tasks/b.md", title: "B", total: 1, done: 1, allDone: true })
  })

  test("no folder: empty and the branch is not read", async () => {
    expect(await listOddFeatures(join(tmp, "nada"))).toEqual({ features: [] })
  })

  test("loader: shares the load in flight and caches for cacheMs", async () => {
    const root = join(tmp, "lista")
    let clock = 0
    let reads = 0
    const fsx: Fsx = { ...nodeFs, listDir: (p) => (reads++, nodeFs.listDir(p)) }
    const loader = createOddListLoader({ root, fsx, now: () => clock, cacheMs: 1_000 })
    const [a, b] = await Promise.all([loader.load(), loader.load()])
    expect(a).toBe(b)
    expect(reads).toBe(1)
    clock = 500
    expect(await loader.load()).toBe(a)
    expect(reads).toBe(1)
    clock = 1_500
    await loader.load()
    expect(reads).toBe(2)
    loader.dispose()
    clock = 5_000
    await loader.load()
    expect(reads).toBe(2)
  })
})
