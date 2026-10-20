import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type Candidate,
  activePin,
  branchContains,
  branchMatch,
  chooseChange,
  matchBranch,
  isNewPin,
  isValidOddName,
  MAX_ODD_NAME,
  parsePin,
  pinKey,
  readCandidates,
  togglePin,
} from "../../src/sources/choice.ts"
import type { GitRemote } from "../../src/sources/sdd-detail.ts"

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-choice-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const AZURE: GitRemote = { url: "https://dev.azure.com/barista/Barista/_git/app", azure: { org: "barista", project: "Barista", repo: "app" } }
const GITHUB: GitRemote = { url: "git@github.com:a/b.git" }
const ab = (id: string) => ({ ref: `AB#${id}`, system: "azure-devops" as const, id, source: "openspec-yaml" as const })

/** Newest to oldest, like `activeChanges`. */
const DEMO: Candidate[] = [
  { name: "ticket-digital" },
  { name: "pago-con-bizum", workItem: ab("1201") },
  { name: "fidelizacion-puntos", workItem: ab("1187") },
  { name: "reservas-online", workItem: { ref: "CAFE-42", system: "jira", id: "CAFE-42", source: "openspec-yaml" } },
  { name: "pedidos-en-mesa" },
  { name: "puntos" },
]

describe("chooseChange", () => {
  test("the pin beats the branch and the date", () => {
    const git = { branch: "feature/1187-fidelizacion-puntos", remote: AZURE }
    expect(chooseChange(DEMO, git, { kind: "sdd", name: "pedidos-en-mesa", branch: git.branch })).toEqual({ index: 4, reason: "pinned" })
  })

  test("pinned on another branch or to a change that is gone: ignored", () => {
    const git = { branch: "feature/1187-fidelizacion-puntos", remote: AZURE }
    expect(chooseChange(DEMO, git, { kind: "sdd", name: "pedidos-en-mesa", branch: "main" })).toEqual({ index: 2, reason: "branch" })
    expect(chooseChange(DEMO, git, { kind: "sdd", name: "archivado", branch: git.branch })).toEqual({ index: 2, reason: "branch" })
    expect(chooseChange(DEMO, { branch: "main" }, { kind: "sdd", name: "archivado", branch: "main" })).toEqual({ index: 0, reason: "recent" })
  })

  test("branch work item equal to the change's workItem", () => {
    expect(chooseChange(DEMO, { branch: "feature/1201-otra-cosa", remote: AZURE })).toEqual({ index: 1, reason: "branch" })
    // The change already says it is Azure DevOps: the number counts even if the remote is not.
    expect(chooseChange(DEMO, { branch: "feature/1201-otra-cosa", remote: GITHUB })).toEqual({ index: 1, reason: "branch" })
    expect(chooseChange(DEMO, { branch: "feat/AB#1187" })).toEqual({ index: 2, reason: "branch" })
    expect(chooseChange(DEMO, { branch: "bugfix/cafe-42-x" })).toEqual({ index: 0, reason: "recent" })
    expect(chooseChange(DEMO, { branch: "bugfix/CAFE-42-x" })).toEqual({ index: 3, reason: "branch" })
  })

  test("matchBranch: index and why it matches (work item or name, with its length)", () => {
    expect(matchBranch(DEMO, { branch: "feature/1201-puntos", remote: AZURE })).toEqual({ index: 1, match: { by: "workItem", length: 14 } })
    expect(matchBranch(DEMO, { branch: "feat/fidelizacion-puntos" })).toEqual({ index: 2, match: { by: "name", length: 19 } })
    expect(matchBranch(DEMO, { branch: "main" })).toBeUndefined()
    expect(matchBranch(DEMO, {})).toBeUndefined()
  })

  test("the work item beats the name; among names, the longest", () => {
    expect(branchMatch(DEMO, { branch: "feature/1201-puntos", remote: AZURE })).toBe(1)
    expect(branchMatch(DEMO, { branch: "feat/fidelizacion-puntos" })).toBe(2)
    expect(branchMatch(DEMO, { branch: "feat/puntos" })).toBe(5)
  })

  test("change name contained in the branch", () => {
    expect(chooseChange(DEMO, { branch: "feat/pedidos-en-mesa" })).toEqual({ index: 4, reason: "branch" })
    expect(chooseChange(DEMO, { branch: "users/jdoe/Ticket-Digital_v2" })).toEqual({ index: 0, reason: "branch" })
  })

  test("no match and no branch: the newest", () => {
    expect(chooseChange(DEMO, { branch: "main", remote: AZURE })).toEqual({ index: 0, reason: "recent" })
    expect(chooseChange(DEMO, {})).toEqual({ index: 0, reason: "recent" })
    expect(chooseChange([], {})).toEqual({ index: 0, reason: "recent" })
  })
})

describe("branchContains", () => {
  test("whole chunks, case-insensitive", () => {
    expect(branchContains("feature/1187-fidelizacion-puntos", "fidelizacion-puntos")).toBe(true)
    expect(branchContains("feature/1187-fidelizacion-puntos", "puntos")).toBe(true)
    expect(branchContains("feat/cachear", "cache")).toBe(false)
    expect(branchContains("feat/precache", "cache")).toBe(false)
    expect(branchContains("feat/cache-cache2", "cache")).toBe(true)
    expect(branchContains("feat/X", "")).toBe(false)
  })

  test("huge repetitive branch: linear in practice", () => {
    const branch = "a".repeat(2_000)
    const start = performance.now()
    expect(branchContains(branch, "a".repeat(50) + "b")).toBe(false)
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe("pin", () => {
  test("Enter pins; Enter on the pinned one releases it; on another, switches", () => {
    const pin = togglePin(undefined, "sdd", "pago-con-bizum", "feat/x")
    expect(pin).toEqual({ kind: "sdd", name: "pago-con-bizum", branch: "feat/x" })
    expect(togglePin(pin, "sdd", "pago-con-bizum", "feat/x")).toBeUndefined()
    expect(togglePin(pin, "sdd", "ticket-digital", "feat/x")).toEqual({ kind: "sdd", name: "ticket-digital", branch: "feat/x" })
    // On another branch the old pin does not count: Enter pins for the current branch.
    expect(togglePin(pin, "sdd", "pago-con-bizum", "main")).toEqual({ kind: "sdd", name: "pago-con-bizum", branch: "main" })
    expect(togglePin(undefined, "sdd", "pago-con-bizum", undefined)).toEqual({ kind: "sdd", name: "pago-con-bizum", branch: "" })
  })

  test("a single pin: pinning an ODD feature replaces the SDD change, and vice versa", () => {
    const sdd = togglePin(undefined, "sdd", "modo-oscuro", "main")
    const odd = togglePin(sdd, "odd", "modo-oscuro", "main")
    expect(odd).toEqual({ kind: "odd", name: "modo-oscuro", branch: "main" })
    expect(togglePin(odd, "sdd", "modo-oscuro", "main")).toEqual({ kind: "sdd", name: "modo-oscuro", branch: "main" })
    expect(togglePin(odd, "odd", "modo-oscuro", "main")).toBeUndefined()
  })

  test("activePin: only of its kind, on its branch and while it still exists", () => {
    const names = DEMO.map((c) => c.name)
    expect(activePin({ kind: "sdd", name: "puntos", branch: "main" }, "sdd", "main", names)).toBe("puntos")
    expect(activePin({ kind: "sdd", name: "puntos", branch: "main" }, "odd", "main", names)).toBeUndefined()
    expect(activePin({ kind: "odd", name: "puntos", branch: "main" }, "odd", "main", names)).toBe("puntos")
    expect(activePin({ kind: "sdd", name: "puntos", branch: "main" }, "sdd", "feat/x", names)).toBeUndefined()
    expect(activePin({ kind: "sdd", name: "otro", branch: "main" }, "sdd", "main", names)).toBeUndefined()
    expect(activePin({ kind: "sdd", name: "puntos", branch: "" }, "sdd", undefined, names)).toBe("puntos")
    expect(activePin(undefined, "sdd", "main", names)).toBeUndefined()
  })

  test("parsePin: new shape, the old one as SDD, garbage out", () => {
    expect(parsePin({ kind: "sdd", name: "puntos", branch: "main" })).toEqual({ kind: "sdd", name: "puntos", branch: "main" })
    expect(parsePin({ kind: "odd", name: "modo-oscuro-carta", branch: "main", extra: 1 })).toEqual({ kind: "odd", name: "modo-oscuro-carta", branch: "main" })
    // T13 stored `{ change, branch }`.
    expect(parsePin({ change: "puntos", branch: "main" })).toEqual({ kind: "sdd", name: "puntos", branch: "main" })
    expect(parsePin({ change: "puntos", branch: "main", extra: 1 })).toEqual({ kind: "sdd", name: "puntos", branch: "main" })
    for (const bad of [
      undefined,
      null,
      "puntos",
      3,
      [],
      { change: "puntos" },
      { change: 1, branch: "main" },
      { change: "--help", branch: "main" },
      { change: "puntos", branch: "x".repeat(5_000) },
      { kind: "sdd", change: "puntos", branch: "main" },
      { kind: "otro", name: "puntos", branch: "main" },
      { kind: "odd", branch: "main" },
      { kind: "odd", name: 3, branch: "main" },
      { kind: "sdd", name: "start", branch: "main" },
      { name: "puntos", branch: "main" },
    ]) {
      expect(parsePin(bad)).toBeUndefined()
    }
  })

  test("parsePin: origin new or manual is kept; without it or with another value, manual", () => {
    expect(parsePin({ kind: "sdd", name: "puntos", branch: "main", origin: "new" })).toEqual({ kind: "sdd", name: "puntos", branch: "main", origin: "new" })
    expect(parsePin({ kind: "odd", name: "modo-oscuro-carta", branch: "", origin: "new" })).toEqual({ kind: "odd", name: "modo-oscuro-carta", branch: "", origin: "new" })
    expect(parsePin({ kind: "sdd", name: "puntos", branch: "main", origin: "manual" })).toEqual({ kind: "sdd", name: "puntos", branch: "main", origin: "manual" })
    for (const origin of [undefined, "otro", 1, null, { new: true }]) {
      const pin = parsePin({ kind: "sdd", name: "puntos", branch: "main", origin })
      expect(pin, JSON.stringify(origin)).toEqual({ kind: "sdd", name: "puntos", branch: "main" })
      expect(isNewPin(pin)).toBe(false)
    }
    expect(isNewPin(parsePin({ kind: "odd", name: "x", branch: "main", origin: "new" }))).toBe(true)
    expect(isNewPin(undefined)).toBe(false)
    // The old shape has no origin; an origin does not save an invalid pin.
    expect(parsePin({ change: "puntos", branch: "main", origin: "new" })).toEqual({ kind: "sdd", name: "puntos", branch: "main", origin: "new" })
    expect(parsePin({ kind: "sdd", name: "--help", branch: "main", origin: "new" })).toBeUndefined()
  })

  test("Enter on another change replaces the new-pin with a manual pin; on the same one, releases it", () => {
    const auto = { kind: "sdd", name: "prueba-nueva", branch: "main", origin: "new" } as const
    expect(togglePin(auto, "odd", "modo-oscuro-carta", "main")).toEqual({ kind: "odd", name: "modo-oscuro-carta", branch: "main" })
    expect(togglePin(auto, "sdd", "prueba-nueva", "main")).toBeUndefined()
  })

  test("ODD names: only safe file stems", () => {
    for (const ok of ["modo-oscuro-carta", "gentle_flow.v2", "café", "a"]) expect(isValidOddName(ok), ok).toBe(true)
    for (const bad of ["", "../fuera", "a/b", "a\\b", "..", ".oculto", "-x", "a..b", "a\u0000b", "a\nb", "x".repeat(MAX_ODD_NAME + 1)]) {
      expect(isValidOddName(bad), JSON.stringify(bad)).toBe(false)
      expect(parsePin({ kind: "odd", name: bad, branch: "main" })).toBeUndefined()
    }
    expect(isValidOddName("x".repeat(MAX_ODD_NAME))).toBe(true)
  })

  test("per-project key", () => {
    expect(pinKey("/Users/x/proyecto", "ses_abc")).toBe("openspec-status:pin:/Users/x/proyecto:ses_abc")
  })
})

describe("readCandidates", () => {
  test("work item from each change's .openspec.yaml; without yaml or with a link leaving the root, nothing", async () => {
    const root = join(tmp, "p")
    const changes = join(root, "openspec", "changes")
    for (const name of ["a", "b", "c"]) mkdirSync(join(changes, name), { recursive: true })
    writeFileSync(join(changes, "a", ".openspec.yaml"), "schema: spec-driven\nworkItem: AB#1187\n")
    writeFileSync(join(tmp, "fuera.yaml"), "workItem: AB#666\n")
    symlinkSync(join(tmp, "fuera.yaml"), join(changes, "c", ".openspec.yaml"))
    const out = await readCandidates(root, ["a", "b", "c"], undefined, AZURE)
    expect(out).toEqual([{ name: "a", workItem: expect.objectContaining({ ref: "AB#1187", source: "openspec-yaml" }) }, { name: "b" }, { name: "c" }])
  })
})
