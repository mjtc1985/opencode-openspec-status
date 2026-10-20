import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Fsx } from "../../src/sources/exec.ts"
import { nodeFs } from "../../src/sources/exec.ts"
import {
  detectWorkItem,
  insideRoot,
  loadSddDetail,
  parseApplyProgress,
  parseDesign,
  parseGitHead,
  parseGitRemote,
  parseOpenspecYaml,
  parseProposal,
  parseSpec,
  parseTasks,
  parseVerifyReport,
  readGitInfo,
  stripCredentials,
  workItemUrl,
} from "../../src/sources/sdd-detail.ts"

const FIX = join(import.meta.dir, "..", "fixtures", "openspec-synth-detail")
const raw = (path: string) => readFileSync(join(FIX, path), "utf8")

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-detail-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const AZURE = parseGitRemote('[remote "origin"]\n\turl = https://dev.azure.com/contoso/Tienda%20Online/_git/precios\n')!

describe("proposal", () => {
  test("fixture: why in one paragraph, top-level bullets and capabilities", () => {
    const p = parseProposal(raw("add-price-cache/proposal.md"))
    expect(p.why).toStartWith("Cada consulta de precio llama al servicio de tarifas")
    expect(p.why).toContain("Una caché por región y producto")
    expect(p.changes).toHaveLength(7)
    // Indented continuation joined; nested bullets out; no markup.
    expect(p.changes[1]).toBe("TTL configurable por entorno (PRICE_CACHE_TTL), con valor por defecto de cinco minutos.")
    expect(p.changes[2]).toBe("Invalidación al publicar un censo nuevo de tarifas:")
    expect(p.capabilities).toEqual([
      { name: "price-cache", kind: "new" },
      { name: "pricing-api", kind: "modified" },
    ])
  })

  test("Spanish headings and «Ninguna.» without a capability", () => {
    const p = parseProposal(raw("fix-om-decimals/proposal.md"))
    expect(p.why).toStartWith("Las cantidades de la orden de montaje")
    expect(p.changes).toEqual(["Conversión de unidades con aritmética decimal.", "Redondeo solo al presentar, nunca al guardar."])
    expect(p.capabilities).toEqual([{ name: "order-units", kind: "modified" }])
  })

  test("no Why, HTML comment in modified capabilities and an unquoted name", () => {
    const md = "# Proposal\n\n## What Changes\n\n- Uno\n\n## Capabilities\n\n### New Capabilities\n- stock-sync: sincroniza\n\n### Modified Capabilities\n<!-- ninguna -->\n"
    const p = parseProposal(md)
    expect(p.why).toBeUndefined()
    expect(p.changes).toEqual(["Uno"])
    expect(p.capabilities).toEqual([{ name: "stock-sync", kind: "new" }])
  })

  test("garbage: empty fields, never throws", () => {
    expect(parseProposal("")).toEqual({ changes: [], capabilities: [] })
    expect(parseProposal("\u0000\u0001 ### ## -\n```\n## Why\n```")).toEqual({ changes: [], capabilities: [] })
  })
})

describe("specs", () => {
  test("ADDED with scenarios counted", () => {
    const s = parseSpec(raw("add-price-cache/specs/price-cache/spec.md"), "price-cache", "specs/price-cache/spec.md")
    expect(s.capability).toBe("price-cache")
    expect(s.requirements).toEqual([
      { title: "Clave de caché por región y producto", delta: "added", scenarios: 2 },
      { title: "Vigencia configurable", delta: "added", scenarios: 1 },
      { title: "Invalidación al publicar censo", delta: "added", scenarios: 3 },
    ])
  })

  test("MODIFIED, REMOVED and RENAMED", () => {
    const s = parseSpec(raw("add-price-cache/specs/pricing-api/spec.md"), "pricing-api", "x")
    expect(s.requirements).toEqual([
      { title: "Consulta de precio", delta: "modified", scenarios: 1 },
      { title: "Consulta directa al servicio de tarifas", delta: "removed", scenarios: 0 },
      { title: "Precio por región y producto", delta: "renamed", scenarios: 0 },
    ])
  })

  test("Spanish headings and requirements without a delta section", () => {
    const md = [
      "## Requisitos AÑADIDOS",
      "### Requisito: Uno",
      "#### Escenario: a",
      "#### Escenario: b",
      "## Requisitos ELIMINADOS",
      "### Requisito: Dos",
      "## Purpose",
      "### Requirement: Suelto",
      "### Otra cosa",
    ].join("\n")
    // Under «Purpose» only «Requirement:» headings count.
    const s = parseSpec(md, "c", "f")
    expect(s.requirements.map((r) => [r.title, r.delta, r.scenarios])).toEqual([
      ["Uno", "added", 2],
      ["Dos", "removed", 0],
      ["Suelto", "unknown", 0],
    ])
    expect(parseSpec("## Requirements\n### Z\n", "c", "f").requirements[0]!.delta).toBe("unknown")
    expect(parseSpec("## Añadidos\n### Requisito: X\n", "c", "f").requirements[0]!.delta).toBe("added")
    expect(parseSpec("## Modificados\n### Y\n", "c", "f").requirements[0]).toEqual({ title: "Y", delta: "modified", scenarios: 0 })
  })
})

describe("design", () => {
  test("unnumbered decisions and risks without brackets", () => {
    const d = parseDesign(raw("add-price-cache/design.md"))
    expect(d.decisions).toEqual(["Caché en memoria por instancia", "Clave compuesta región y producto", "Invalidación por evento de censo"])
    expect(d.risks).toHaveLength(2)
    expect(d.risks[0]).toStartWith("Precios desfasados entre instancias → cada instancia tiene su caché.")
  })

  test("in Spanish and with bullets instead of subheadings", () => {
    const d = parseDesign("## Decisiones\n\n- Usar A\n- Usar B\n\n## Riesgos\n\n- Latencia\n")
    expect(d).toEqual({ decisions: ["Usar A", "Usar B"], risks: ["Latencia"] })
    expect(parseDesign("nada")).toEqual({ decisions: [], risks: [] })
  })
})

describe("tasks", () => {
  test("groups, ids, indented continuation and the current task", () => {
    const t = parseTasks(raw("add-price-cache/tasks.md"))
    expect(t.groups.map((g) => [g.title, g.items.length])).toEqual([
      ["1. Caché", 4],
      ["2. Integración", 5],
      ["3. Pruebas", 4],
      ["4. Documentación", 3],
    ])
    const items = t.groups.flatMap((g) => g.items)
    expect(items.filter((i) => i.done)).toHaveLength(6)
    expect(items[5]).toEqual({ id: "2.2", text: "Envolver el cliente de tarifas con reintentos y espera exponencial", done: true })
    expect(t.current).toEqual({ group: 1, item: 2, text: "2.3 Cachear precios por región" })
  })

  test("all done: no current task; tasks without group or id", () => {
    expect(parseTasks("## A\n- [x] 1.1 a\n- [X] 1.2 b\n").current).toBeUndefined()
    const t = parseTasks("# Tareas\n- [ ] hacer algo\n- [x] T3 otra\n## Vacío\n\ntexto\n")
    expect(t.groups).toEqual([
      {
        title: "",
        items: [
          { text: "hacer algo", done: false },
          { id: "T3", text: "otra", done: true },
        ],
      },
    ])
    expect(t.current).toEqual({ group: 0, item: 0, text: "hacer algo" })
    expect(parseTasks("")).toEqual({ groups: [] })
  })
})

describe("apply-progress and verify-report", () => {
  test("apply-progress: checkboxes, headings and result lines", () => {
    expect(parseApplyProgress(raw("add-price-cache/apply-progress.md")).summary).toEqual([
      "6/6 marcadas",
      "Lote 1: caché",
      "Lote 2: integración",
      "Estado: tests unitarios PASS (24 pruebas, 0 failed)",
    ])
    expect(parseApplyProgress("garbage").summary).toEqual([])
  })

  test("verify: PASS verdict from the Verdict line", () => {
    const v = parseVerifyReport(raw("add-price-cache/verify-report.md"))
    expect(v.verdict).toBe("pass")
    expect(v.summary[0]).toBe("Verdict: PASS WITH WARNINGS")
    expect(v.summary).toContain("Clave de caché por región y producto ✅ COMPLIANT")
  })

  test("verify: FAIL, loose marks, «0 failed» and unknown", () => {
    expect(parseVerifyReport("# Informe\n\n**Veredicto**: FAIL\n").verdict).toBe("fail")
    expect(parseVerifyReport("Resultado: ❌ no cumple\n").verdict).toBe("fail")
    expect(parseVerifyReport("- ✅ a\n- ❌ b\n").verdict).toBe("fail")
    expect(parseVerifyReport("- ✅ a\n- ✅ b\n").verdict).toBe("pass")
    expect(parseVerifyReport("Status: PASS, 0 failed\n").verdict).toBe("pass")
    expect(parseVerifyReport("tests: 12 passed, failed: 0\n").verdict).toBe("pass")
    expect(parseVerifyReport("# Informe\n\nPendiente de revisar.\n")).toEqual({ verdict: "unknown", summary: [] })
    expect(parseVerifyReport("")).toEqual({ verdict: "unknown", summary: [] })
  })
})

describe(".openspec.yaml", () => {
  test("key: value, quotes and comments", () => {
    expect(parseOpenspecYaml(raw("add-price-cache/.openspec.yaml"))).toEqual({ schema: "spec-driven", created: "2026-09-28", workItem: "AB#48213" })
    expect(parseOpenspecYaml('skip_specs: true\nwork_item: "PROJ-7"\n  nested: x\n- lista\n')).toEqual({ skip_specs: "true", work_item: "PROJ-7" })
    expect(parseOpenspecYaml("\u0000::")).toEqual({})
  })
})

describe("git remote", () => {
  test("Azure DevOps https without credentials", () => {
    const r = parseGitRemote('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://jdoe:s3cr3tT0ken@dev.azure.com/contoso/Tienda/_git/precios\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')!
    expect(r).toEqual({ url: "https://dev.azure.com/contoso/Tienda/_git/precios", azure: { org: "contoso", project: "Tienda", repo: "precios" } })
    expect(JSON.stringify(r)).not.toContain("s3cr3t")
    expect(JSON.stringify(r)).not.toContain("jdoe")
  })

  test("ssh, visualstudio.com, origin preferred and other hosts", () => {
    expect(parseGitRemote('[remote "origin"]\n url = git@ssh.dev.azure.com:v3/contoso/Tienda/precios\n')!.azure).toEqual({ org: "contoso", project: "Tienda", repo: "precios" })
    expect(parseGitRemote('[remote "origin"]\n url = https://contoso.visualstudio.com/DefaultCollection/Tienda/_git/precios\n')!.azure).toEqual({
      org: "contoso",
      project: "Tienda",
      repo: "precios",
    })
    expect(parseGitRemote('[remote "origin"]\n url = https://user:pw@contoso.visualstudio.com/Tienda/_git/precios\n')!.url).toBe("https://contoso.visualstudio.com/Tienda/_git/precios")
    const two = parseGitRemote('[remote "fork"]\n url = https://github.com/a/b.git\n[remote "origin"]\n url = git@github.com:c/d.git\n')!
    expect(two).toEqual({ url: "git@github.com:c/d.git" })
    expect(parseGitRemote("[core]\n bare = false\n")).toBeUndefined()
    expect(stripCredentials("ssh://u:p@host/x")).toBe("ssh://host/x")
  })

  test("credentials with an unencoded @ and the scp form: nothing leaks", () => {
    expect(stripCredentials("https://user:p@ss@org.visualstudio.com/P/_git/r")).toBe("https://org.visualstudio.com/P/_git/r")
    const r = parseGitRemote('[remote "origin"]\n url = https://user:p@ss@org.visualstudio.com/P/_git/r\n')!
    expect(r).toEqual({ url: "https://org.visualstudio.com/P/_git/r", azure: { org: "org", project: "P", repo: "r" } })
    expect(stripCredentials("jdoe:t0k@en@ssh.dev.azure.com:v3/contoso/Tienda/precios")).toBe("ssh.dev.azure.com:v3/contoso/Tienda/precios")
    expect(parseGitRemote('[remote "origin"]\n url = jdoe:t0k@en@ssh.dev.azure.com:v3/contoso/Tienda/precios\n')!.azure).toEqual({ org: "contoso", project: "Tienda", repo: "precios" })
    // No password: the scp-form user stays; an @ in the path is left alone.
    expect(stripCredentials("git@github.com:c/d.git")).toBe("git@github.com:c/d.git")
    expect(stripCredentials("https://host/a@b")).toBe("https://host/a@b")
  })

  test("HEAD: branch or detached", () => {
    expect(parseGitHead("ref: refs/heads/feature/48213-cache\n")).toBe("feature/48213-cache")
    expect(parseGitHead("3f2a9c0d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c\n")).toBeUndefined()
  })

  test("Azure work item URL, with the project encoded", () => {
    expect(workItemUrl({ system: "azure-devops", id: "48213" }, AZURE)).toBe("https://dev.azure.com/contoso/Tienda%20Online/_workitems/edit/48213")
    expect(workItemUrl({ system: "jira", id: "PROJ-1" }, AZURE)).toBeUndefined()
    expect(workItemUrl({ system: "azure-devops", id: "1" }, { url: "git@github.com:a/b.git" })).toBeUndefined()
  })
})

describe("work item", () => {
  const URL_48213 = "https://dev.azure.com/contoso/Tienda%20Online/_workitems/edit/48213"

  test("from .openspec.yaml: AB#, Jira, Azure URL, any URL and a number with an Azure remote", () => {
    expect(detectWorkItem({ yaml: { workItem: "AB#48213" }, remote: AZURE })).toEqual({ ref: "AB#48213", system: "azure-devops", id: "48213", url: URL_48213, source: "openspec-yaml" })
    expect(detectWorkItem({ yaml: { work_item: "PROJ-123" } })).toEqual({ ref: "PROJ-123", system: "jira", id: "PROJ-123", source: "openspec-yaml" })
    expect(detectWorkItem({ yaml: { workitem: "https://tok@dev.azure.com/contoso/Tienda/_workitems/edit/77" } })).toEqual({
      ref: "AB#77",
      system: "azure-devops",
      id: "77",
      url: "https://dev.azure.com/contoso/Tienda/_workitems/edit/77",
      source: "openspec-yaml",
    })
    expect(detectWorkItem({ yaml: { workItem: "https://tracker.example.com/issues/9" } })).toEqual({
      ref: "https://tracker.example.com/issues/9",
      system: "url",
      url: "https://tracker.example.com/issues/9",
      source: "openspec-yaml",
    })
    expect(detectWorkItem({ yaml: { workItem: "48213" }, remote: AZURE })?.url).toBe(URL_48213)
    expect(detectWorkItem({ yaml: { workItem: "48213" } })).toBeUndefined()
  })

  test("AB# without an Azure remote: no URL", () => {
    expect(detectWorkItem({ yaml: { workItem: "AB#5" } })).toEqual({ ref: "AB#5", system: "azure-devops", id: "5", source: "openspec-yaml" })
  })

  test("from the branch; the yaml wins over the branch", () => {
    expect(detectWorkItem({ branch: "feature/48213-price-cache", remote: AZURE })).toMatchObject({ ref: "AB#48213", url: URL_48213, source: "branch" })
    expect(detectWorkItem({ branch: "feat/AB#48213", remote: AZURE })).toMatchObject({ id: "48213", source: "branch" })
    expect(detectWorkItem({ branch: "users/jdoe/48213-cache", remote: AZURE })).toMatchObject({ id: "48213", source: "branch" })
    expect(detectWorkItem({ branch: "feature/PROJ-42-cache" })).toEqual({ ref: "PROJ-42", system: "jira", id: "PROJ-42", source: "branch" })
    // A number in the branch without an Azure remote: nothing is made up.
    expect(detectWorkItem({ branch: "feature/48213-price-cache", remote: { url: "git@github.com:a/b.git" } })).toBeUndefined()
    expect(detectWorkItem({ branch: "feat/gentle-flow", remote: AZURE })).toBeUndefined()
    expect(detectWorkItem({ yaml: { workItem: "PROJ-1" }, branch: "feature/48213-x", remote: AZURE })?.source).toBe("openspec-yaml")
  })

  test("from the proposal only AB# or an Azure URL; never Jira-like keys", () => {
    const proposal = raw("fix-om-decimals/proposal.md") // menciona calle-real-34 y OM-2291
    expect(detectWorkItem({ proposal })).toBeUndefined()
    expect(detectWorkItem({ proposal: "Relacionado con PROJ-9 y calle-real-34." })).toBeUndefined()
    expect(detectWorkItem({ proposal: "Ver AB#321 para el contexto.", remote: AZURE })).toMatchObject({ ref: "AB#321", source: "proposal" })
    expect(detectWorkItem({ proposal: "Ver https://dev.azure.com/o/p/_workitems/edit/12 ya." })).toMatchObject({ id: "12", url: "https://dev.azure.com/o/p/_workitems/edit/12" })
    expect(detectWorkItem({})).toBeUndefined()
  })
})

// ── Reader ──────────────────────────────────────────────────────────────────

function project(name: string, git: "dir" | "file" | "none" = "dir"): string {
  const root = join(tmp, name)
  const changes = join(root, "openspec", "changes")
  mkdirSync(changes, { recursive: true })
  cpSync(FIX, changes, { recursive: true })
  if (git === "dir") {
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/feature/99-otra\n")
    writeFileSync(join(root, ".git", "config"), '[remote "origin"]\n\turl = https://jdoe:pat123@dev.azure.com/contoso/Tienda/_git/precios\n')
  }
  return root
}

function status(root: string, change: string, overrides: Record<string, unknown> = {}) {
  const dir = join(root, "openspec", "changes", change)
  const has = (f: string) => {
    try {
      readFileSync(join(dir, f))
      return [join(dir, f)]
    } catch {
      return []
    }
  }
  return {
    changeName: change,
    changeRoot: dir,
    artifactPaths: {
      proposal: has("proposal.md"),
      specs: [...has("specs/price-cache/spec.md"), ...has("specs/pricing-api/spec.md")],
      design: has("design.md"),
      tasks: has("tasks.md"),
      applyProgress: has("apply-progress.md"),
      verifyReport: has("verify-report.md"),
    },
    ...overrides,
  }
}

describe("loadSddDetail", () => {
  test("full change: every artifact, relative paths, mtimes and the yaml work item", async () => {
    const root = project("full")
    const tasks = join(root, "openspec/changes/add-price-cache/tasks.md")
    utimesSync(tasks, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    const d = (await loadSddDetail(root, status(root, "add-price-cache")))!
    expect(d.change).toBe("add-price-cache")
    expect(d.changeDir).toBe("openspec/changes/add-price-cache")
    expect(d.proposal?.capabilities).toHaveLength(2)
    expect(d.specs.map((s) => [s.capability, s.file, s.requirements.length])).toEqual([
      ["price-cache", "openspec/changes/add-price-cache/specs/price-cache/spec.md", 3],
      ["pricing-api", "openspec/changes/add-price-cache/specs/pricing-api/spec.md", 3],
    ])
    expect(d.design?.decisions).toHaveLength(3)
    expect(d.tasks?.current?.text).toBe("2.3 Cachear precios por región")
    expect(d.applyProgress?.summary[0]).toBe("6/6 marcadas")
    expect(d.verify?.verdict).toBe("pass")
    expect(d.files.tasks).toEqual([{ path: "openspec/changes/add-price-cache/tasks.md", mtime: 1_700_000_000_000 }])
    expect(d.files.specs).toHaveLength(2)
    expect(d.workItem).toEqual({
      ref: "AB#48213",
      system: "azure-devops",
      id: "48213",
      url: "https://dev.azure.com/contoso/Tienda/_workitems/edit/48213",
      source: "openspec-yaml",
    })
    const json = JSON.stringify(d)
    expect(json).not.toContain("pat123")
    expect(json).not.toContain(root) // nada absoluto
  })

  test("partial change: missing artifacts → absent fields; the branch work item if it is its change", async () => {
    const root = project("partial")
    const d = (await loadSddDetail(root, status(root, "fix-om-decimals"), nodeFs, { branchMatched: true }))!
    expect(d.proposal).toBeDefined()
    expect(d.tasks?.groups).toHaveLength(1)
    expect(d.design).toBeUndefined()
    expect(d.verify).toBeUndefined()
    expect(d.applyProgress).toBeUndefined()
    expect(d.specs).toEqual([])
    expect(d.files.design).toEqual([])
    expect(d.workItem).toMatchObject({ ref: "AB#99", source: "branch", url: "https://dev.azure.com/contoso/Tienda/_workitems/edit/99" })
  })

  test("if the branch is not this change's, its work item is not attributed to it", async () => {
    const root = project("partial-other")
    expect((await loadSddDetail(root, status(root, "fix-om-decimals")))!.workItem).toBeUndefined()
    expect((await loadSddDetail(root, status(root, "fix-om-decimals"), nodeFs, { branchMatched: false }))!.workItem).toBeUndefined()
    // Its own (.openspec.yaml) is still shown.
    expect((await loadSddDetail(root, status(root, "add-price-cache")))!.workItem).toMatchObject({ ref: "AB#48213", source: "openspec-yaml" })
  })

  test("paths outside the root: ignored without reading them", async () => {
    const root = project("traversal", "none")
    const outside = join(tmp, "secreto.md")
    writeFileSync(outside, "## Why\n\nNo debería leerse.\n")
    const read: string[] = []
    const spy: Fsx = { ...nodeFs, readText: (p) => (read.push(p), nodeFs.readText(p)), mtime: (p) => (read.push(p), nodeFs.mtime(p)) }
    const s = status(root, "fix-om-decimals", {
      changeRoot: join(root, "..", "fuera"),
      artifactPaths: { proposal: [join(root, "openspec", "..", "..", "secreto.md")], design: ["/etc/hosts"], specs: "no", tasks: [42] },
    })
    const d = (await loadSddDetail(root, s, spy))!
    expect(d.proposal).toBeUndefined()
    expect(d.design).toBeUndefined()
    expect(d.changeDir).toBeUndefined()
    expect(d.files.proposal).toEqual([])
    expect(read.some((p) => p.includes("secreto") || p === "/etc/hosts" || p.includes("fuera"))).toBe(false)
    expect(insideRoot("/a/b", "/a/b/c")).toBe("/a/b/c")
    expect(insideRoot("/a/b", "/a/bc")).toBeUndefined()
    expect(insideRoot("/a/b", "c/../../x")).toBeUndefined()
  })

  test("links inside the root pointing outside: not read", async () => {
    const root = project("enlaces", "none")
    const dir = join(root, "openspec", "changes", "fix-om-decimals")
    writeFileSync(join(tmp, "fuera-proposal.md"), "## Why\n\nsecreto-de-fuera\n")
    writeFileSync(join(tmp, "fuera.yaml"), "workItem: AB#666\n")
    rmSync(join(dir, "proposal.md"))
    symlinkSync(join(tmp, "fuera-proposal.md"), join(dir, "proposal.md"))
    rmSync(join(dir, ".openspec.yaml"), { force: true })
    symlinkSync(join(tmp, "fuera.yaml"), join(dir, ".openspec.yaml"))
    const d = (await loadSddDetail(root, status(root, "fix-om-decimals", { artifactPaths: { proposal: [join(dir, "proposal.md")] } })))!
    expect(d.proposal).toBeUndefined()
    expect(d.files.proposal).toEqual([])
    expect(d.workItem).toBeUndefined()
    expect(JSON.stringify(d)).not.toContain("secreto")
  })

  test("JSON without a change, or garbage: undefined, never throws", async () => {
    expect(await loadSddDetail(tmp, null)).toBeUndefined()
    expect(await loadSddDetail(tmp, { changeName: null })).toBeUndefined()
    expect(await loadSddDetail(tmp, "texto")).toBeUndefined()
    const d = (await loadSddDetail(join(tmp, "no-existe"), { changeName: "x", artifactPaths: 3 }))!
    expect(d).toEqual({ change: "x", specs: [], files: { proposal: [], specs: [], design: [], tasks: [], applyProgress: [], verifyReport: [] } })
  })

  test(".git as a file (worktree): gitdir is followed and only HEAD and config are read", async () => {
    const root = project("worktree", "none")
    const gitdir = join(tmp, "main-repo", ".git", "worktrees", "wt")
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feat/AB#555-x\n")
    writeFileSync(join(gitdir, "config"), '[remote "origin"]\n url = git@ssh.dev.azure.com:v3/contoso/Tienda/precios\n')
    writeFileSync(join(root, ".git"), `gitdir: ${gitdir}\n`)
    const read: string[] = []
    const spy: Fsx = { ...nodeFs, readText: (p) => (read.push(p), nodeFs.readText(p)) }
    const info = await readGitInfo(root, spy)
    expect(info.branch).toBe("feat/AB#555-x")
    expect(info.remote?.azure?.org).toBe("contoso")
    expect(read.filter((p) => p.startsWith(join(tmp, "main-repo"))).sort()).toEqual([join(gitdir, "HEAD"), join(gitdir, "config")].sort())

    // Relative to the root and `.git` without gitdir: nothing.
    writeFileSync(join(root, ".git"), "gitdir: ../main-repo/.git/worktrees/wt\n")
    expect((await readGitInfo(root)).branch).toBe("feat/AB#555-x")
    writeFileSync(join(root, ".git"), "basura\n")
    expect(await readGitInfo(root)).toEqual({})
    expect(await readGitInfo(join(tmp, "no-existe"))).toEqual({})
  })
})
