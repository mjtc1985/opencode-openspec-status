import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run } from "../../src/sources/exec.ts"
import { loadGit, parseGitStatus } from "../../src/sources/git.ts"

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-git-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe("parseGitStatus", () => {
  test("clean when there are no lines", () => {
    expect(parseGitStatus("")).toEqual({ kind: "repo", dirty: false })
    expect(parseGitStatus("\n\n")).toEqual({ kind: "repo", dirty: false })
  })

  test("dirty with any line", () => {
    expect(parseGitStatus(" M src/a.ts\n?? b.ts\n")).toEqual({ kind: "repo", dirty: true })
  })
})

describe("loadGit", () => {
  test("without .git nothing is run", async () => {
    const calls: string[][] = []
    const run: Run = async (_c, args) => (calls.push(args), "")
    expect(await loadGit(tmp, run)).toEqual({ kind: "none" })
    expect(calls).toEqual([])
  })

  test("with .git runs the exact status command", async () => {
    const root = join(tmp, "repo")
    mkdirSync(join(root, ".git"), { recursive: true })
    const calls: [string, string[]][] = []
    const run: Run = async (cmd, args) => (calls.push([cmd, args]), " M x\n")
    expect(await loadGit(root, run)).toEqual({ kind: "repo", dirty: true })
    expect(calls).toEqual([["git", ["--no-optional-locks", "status", "--porcelain"]]])
  })
})
