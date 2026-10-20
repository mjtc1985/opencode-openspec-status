// Without gentle-ai: the sdd-status JSON is inferred from the OpenSpec files and
// the review section is hidden instead of showing an error.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { SddChange, SddState } from "../../src/model.ts"
import { CommandNotFoundError, type Run } from "../../src/sources/exec.ts"
import { countTasks, statusFromFiles } from "../../src/sources/openspec-files.ts"
import { createReviewLoader } from "../../src/sources/review.ts"
import { loadSdd, parseSddStatus, sddStatusJson } from "../../src/sources/sdd.ts"

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-files-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

let n = 0
/** A fresh project folder with `files` (path → content) and an optional mtime in s. */
function project(files: Record<string, string>, mtimes: Record<string, number> = {}): string {
  const root = join(tmp, `p${n++}`)
  mkdirSync(root, { recursive: true })
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    const m = mtimes[path]
    if (m !== undefined) utimesSync(file, m, m)
  }
  return root
}

const changeDir = (name: string) => `openspec/changes/${name}`
const planned = (name: string, tasks: string) => ({
  [`${changeDir(name)}/proposal.md`]: "# Proposal\n",
  [`${changeDir(name)}/specs/cache/spec.md`]: "# Spec\n",
  [`${changeDir(name)}/design.md`]: "# Design\n",
  [`${changeDir(name)}/tasks.md`]: tasks,
})

/** `Run` with no gentle-ai on the PATH, as `createRun` reports it. */
const noGentle: Run = async (cmd) => {
  throw new CommandNotFoundError(cmd, `${cmd} not found`)
}

function asChange(s: SddState): SddChange {
  if (s.kind !== "change") throw new Error(`expected a change, got ${JSON.stringify(s)}`)
  return s
}

describe("countTasks", () => {
  test("checked and unchecked boxes, outside code blocks", () => {
    const md = ["## 1. Cache", "- [x] 1.1 Key", "- [X] 1.2 TTL", "* [ ] 1.3 Limit", "```", "- [ ] not a task", "```", "+ [ ] 1.4 Metrics", "- plain bullet"].join("\n")
    expect(countTasks(md)).toEqual({ total: 4, completed: 2 })
  })

  test("empty or missing: zero", () => {
    expect(countTasks(undefined)).toEqual({ total: 0, completed: 0 })
    expect(countTasks("")).toEqual({ total: 0, completed: 0 })
  })
})

describe("statusFromFiles", () => {
  test("no openspec folder: sdd-new, read by parseSddStatus as nothing active", async () => {
    const root = project({ "README.md": "# x\n" })
    const json = await statusFromFiles(root, undefined)
    expect(json).toMatchObject({ schemaName: "gentle-ai.sdd-status", schemaVersion: 2, changeName: null, nextRecommended: "sdd-new" })
    expect(parseSddStatus(json, { mtimes: {} })).toEqual({ kind: "none", hint: "sdd-new" })
  })

  test("several active changes: select-change with their names; archive does not count", async () => {
    const root = project({
      [`${changeDir("a-first")}/proposal.md`]: "# A\n",
      [`${changeDir("b-second")}/proposal.md`]: "# B\n",
      "openspec/changes/archive/2026-01-01-old/proposal.md": "# old\n",
    })
    const json = await statusFromFiles(root, undefined)
    expect(json).toMatchObject({ nextRecommended: "select-change", changeName: null })
    expect(String((json.blockedReasons as string[])[0])).toContain("a-first")
    expect(String((json.blockedReasons as string[])[0])).not.toContain("old")
  })

  test("proposal only: next spec, apply blocked", async () => {
    const root = project({ [`${changeDir("add-cache")}/proposal.md`]: "# Proposal\n" })
    const json = await statusFromFiles(root, undefined)
    expect(json).toMatchObject({
      changeName: "add-cache",
      artifacts: { proposal: "done", specs: "missing", design: "missing", tasks: "missing" },
      nextRecommended: "spec",
      applyState: "blocked",
    })
  })

  test("planned with half the tasks done: apply ready with its progress", async () => {
    const root = project(planned("add-cache", "- [x] 1.1 Key\n- [ ] 1.2 TTL\n- [ ] 1.3 Limit\n"))
    const json = await statusFromFiles(root, undefined)
    expect(json).toMatchObject({
      nextRecommended: "apply",
      applyState: "ready",
      taskProgress: { total: 3, completed: 1, pending: 2, allComplete: false },
    })
    expect((json.artifactPaths as { specs: string[] }).specs).toEqual([join(root, changeDir("add-cache"), "specs/cache/spec.md")])
  })

  test("every task done: archive and all_done", async () => {
    const root = project(planned("add-cache", "- [x] 1.1 Key\n- [x] 1.2 TTL\n"))
    expect(await statusFromFiles(root, undefined)).toMatchObject({ nextRecommended: "archive", applyState: "all_done" })
  })

  test("tasks without design: apply blocked until the plan is complete", async () => {
    const root = project({
      [`${changeDir("add-cache")}/proposal.md`]: "# P\n",
      [`${changeDir("add-cache")}/specs/cache/spec.md`]: "# S\n",
      [`${changeDir("add-cache")}/tasks.md`]: "- [ ] 1.1 Key\n",
    })
    expect(await statusFromFiles(root, undefined)).toMatchObject({ nextRecommended: "design", applyState: "blocked" })
  })

  test("unsafe or missing change name: nothing read", async () => {
    const root = project({ [`${changeDir("add-cache")}/proposal.md`]: "# P\n" })
    expect(await statusFromFiles(root, "--help")).toMatchObject({ changeName: "--help", nextRecommended: "sdd-new", changeRoot: null })
    expect(await statusFromFiles(root, "gone")).toMatchObject({ changeName: "gone", nextRecommended: "sdd-new", changeRoot: null })
  })

  test("artifacts linked from outside the root do not count", async () => {
    const outside = project({ "proposal.md": "# outside\n" })
    const root = project({})
    mkdirSync(join(root, changeDir("add-cache")), { recursive: true })
    symlinkSync(join(outside, "proposal.md"), join(root, changeDir("add-cache"), "proposal.md"))
    expect(await statusFromFiles(root, undefined)).toMatchObject({ artifacts: { proposal: "missing" }, nextRecommended: "propose" })
  })
})

describe("fallback when gentle-ai is missing", () => {
  test("sddStatusJson: gentle-ai first; files only on CommandNotFoundError", async () => {
    const root = project({ [`${changeDir("add-cache")}/proposal.md`]: "# P\n" })
    expect((await sddStatusJson(root, async () => '{"x":1}')).source).toBe("gentle-ai")
    expect(await sddStatusJson(root, noGentle)).toMatchObject({ source: "files", json: { changeName: "add-cache" } })
    await expect(sddStatusJson(root, async () => Promise.reject(new Error("timeout")))).rejects.toThrow("timeout")
  })

  test("loadSdd: the change comes from the files, marked as source files", async () => {
    const root = project(planned("add-cache", "- [x] 1.1 Key\n- [ ] 1.2 TTL\n"))
    const c = asChange(await loadSdd(root, noGentle))
    expect(c.name).toBe("add-cache")
    expect(c.source).toBe("files")
    expect(c.current).toBe("apply")
    expect(c.tasks).toMatchObject({ total: 2, completed: 1 })
  })

  test("loadSdd with several changes: the newest is picked and read from the files", async () => {
    const root = project(
      { [`${changeDir("older")}/proposal.md`]: "# P\n", ...planned("newer", "- [ ] 1.1 Key\n") },
      { [`${changeDir("older")}/proposal.md`]: 1_000 },
    )
    const c = asChange(await loadSdd(root, noGentle))
    expect(c.name).toBe("newer")
    expect(c.source).toBe("files")
    expect(c.choice).toMatchObject({ index: 1, total: 2, others: ["older"] })
  })

  test("review: no gentle-ai means no review, not an error", async () => {
    const root = project({ ".git/HEAD": "ref: refs/heads/main\n" })
    expect(await createReviewLoader().load(root, noGentle)).toEqual({ kind: "none" })
  })
})
