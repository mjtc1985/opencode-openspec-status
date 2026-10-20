import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  gitStatusArgs,
  isAllowed,
  isInside,
  isValidChangeName,
  newestMtime,
  nodeFs,
  reviewLineageArgs,
  reviewStatusArgs,
  sddStatusArgs,
} from "../../src/sources/exec.ts"

const ROOT = "/p/repo"

describe("command arguments", () => {
  test("sdd-status with and without a change", () => {
    expect(sddStatusArgs(ROOT)).toEqual(["sdd-status", "--json", "--cwd", ROOT])
    expect(sddStatusArgs(ROOT, "c1")).toEqual(["sdd-status", "c1", "--json", "--cwd", ROOT])
  })

  test("review status v1 and v2 by lineage", () => {
    expect(reviewStatusArgs(ROOT)).toEqual(["review", "status", "--cwd", ROOT])
    expect(reviewLineageArgs(ROOT, "review-abc-r1")).toEqual([
      "review",
      "status",
      "--cwd",
      ROOT,
      "--contract=gentle-ai.review-integration/v2",
      "--next-transition=true",
      "--lineage=review-abc-r1",
    ])
  })

  test("git status without optional locks", () => {
    expect(gitStatusArgs()).toEqual(["--no-optional-locks", "status", "--porcelain"])
  })
})

describe("isAllowed", () => {
  test("accepts exactly the read-only forms", () => {
    expect(isAllowed("gentle-ai", sddStatusArgs(ROOT))).toBe(true)
    expect(isAllowed("gentle-ai", sddStatusArgs(ROOT, "c1"))).toBe(true)
    expect(isAllowed("gentle-ai", reviewStatusArgs(ROOT))).toBe(true)
    expect(isAllowed("gentle-ai", reviewLineageArgs(ROOT, "review-ff3e92437e221e59-r1"))).toBe(true)
    expect(isAllowed("git", gitStatusArgs())).toBe(true)
  })

  test("rejects operations that change state", () => {
    expect(isAllowed("gentle-ai", ["review", "start", "--cwd", ROOT])).toBe(false)
    expect(isAllowed("gentle-ai", ["review", "status", "--cwd", ROOT, "--consent=relay"])).toBe(false)
    expect(isAllowed("gentle-ai", ["review", "status", "--cwd", ROOT, "start"])).toBe(false)
    expect(isAllowed("gentle-ai", ["review", "capture-result", "--cwd", ROOT])).toBe(false)
    expect(isAllowed("gentle-ai", ["review", "recover", "--cwd", ROOT])).toBe(false)
    expect(isAllowed("gentle-ai", ["review", "repair", "--cwd", ROOT])).toBe(false)
    expect(isAllowed("gentle-ai", ["review", "mode", "disable"])).toBe(false)
    expect(isAllowed("gentle-ai", ["sdd-continue", "--cwd", ROOT])).toBe(false)
    expect(isAllowed("gentle-ai", ["sdd-status", "start", "--json", "--cwd", ROOT])).toBe(false)
  })

  test("rejects similar but not exact forms", () => {
    expect(isAllowed("gentle-ai", ["sdd-status", "--json"])).toBe(false)
    expect(isAllowed("gentle-ai", ["sdd-status", "--json", "--cwd", ROOT, "--extra"])).toBe(false)
    expect(isAllowed("gentle-ai", ["sdd-status", "--force", "--json", "--cwd", ROOT])).toBe(false)
    expect(isAllowed("gentle-ai", ["review", "status", "--cwd", "--json"])).toBe(false)
    expect(isAllowed("gentle-ai", [...reviewLineageArgs(ROOT, "x"), "--next-transition=false"])).toBe(false)
    expect(isAllowed("gentle-ai", ["review", "status", "--cwd", ROOT, "--contract=otro", "--next-transition=true", "--lineage=x"])).toBe(false)
    expect(isAllowed("gentle-ai", reviewLineageArgs(ROOT, "x;rm -rf /"))).toBe(false)
    expect(isAllowed("git", ["status", "--porcelain"])).toBe(false)
    expect(isAllowed("git", ["--no-optional-locks", "status", "--porcelain", "--ignored"])).toBe(false)
    expect(isAllowed("git", ["init"])).toBe(false)
    expect(isAllowed("rm", ["-rf", ROOT])).toBe(false)
  })
})

describe("isValidChangeName", () => {
  test("the same rules as isAllowed's change argument", () => {
    for (const ok of ["add-price-cache", "fix_1.2", "Cambio"]) expect(isValidChangeName(ok)).toBe(true)
    expect(isValidChangeName("")).toBe(false)
    for (const bad of ["--help", "-x", "start", "mode", "capture-result", "--consent=relay"]) {
      expect(isValidChangeName(bad)).toBe(false)
      expect(isAllowed("gentle-ai", sddStatusArgs(ROOT, bad))).toBe(false)
    }
  })
})

// ── Real files in a temporary directory ─────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-exec-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A folder with a regular file, a FIFO, a link to /dev/zero and another to a folder. */
function hostileDir(name: string): string {
  const dir = join(tmp, name)
  mkdirSync(join(dir, "sub"), { recursive: true })
  writeFileSync(join(dir, "ok.md"), "hola")
  writeFileSync(join(dir, "sub", "x.md"), "x")
  expect(spawnSync("mkfifo", [join(dir, "fifo.md")]).status).toBe(0)
  symlinkSync("/dev/zero", join(dir, "zero.md"))
  symlinkSync(join(dir, "ok.md"), join(dir, "link.md"))
  symlinkSync(join(dir, "sub"), join(dir, "linkdir"))
  return dir
}

describe("bounded reads", () => {
  test("regular file: read in full", async () => {
    const dir = hostileDir("normal")
    expect(await nodeFs.readText(join(dir, "ok.md"))).toBe("hola")
    expect(await nodeFs.readText(join(dir, "link.md"))).toBe("hola")
  })

  test("FIFO: undefined without waiting for a writer", async () => {
    const dir = hostileDir("fifo")
    const timeout = new Promise((resolve) => setTimeout(() => resolve("bloqueado"), 1_000))
    expect(await Promise.race([nodeFs.readText(join(dir, "fifo.md")), timeout])).toBeUndefined()
  })

  test("link to /dev/zero: undefined without reading anything", async () => {
    const dir = hostileDir("zero")
    const before = process.memoryUsage().rss
    expect(await nodeFs.readText(join(dir, "zero.md"))).toBeUndefined()
    expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024)
  })

  test("larger than the cap, or a folder: undefined", async () => {
    const dir = hostileDir("big")
    writeFileSync(join(dir, "big.md"), "x".repeat(2_000))
    expect(await nodeFs.readText(join(dir, "big.md"), { maxBytes: 1_000 })).toBeUndefined()
    expect(await nodeFs.readText(join(dir, "big.md"), { maxBytes: 2_000 })).toHaveLength(2_000)
    expect(await nodeFs.readText(join(dir, "sub"))).toBeUndefined()
  })

  test("listDir: only real folders and regular files (or links to one)", async () => {
    const dir = hostileDir("list")
    const names = (await nodeFs.listDir(dir)).sort((a, b) => a.name.localeCompare(b.name))
    expect(names).toEqual([
      { name: "link.md", dir: false },
      { name: "ok.md", dir: false },
      { name: "sub", dir: true },
    ])
    expect(await newestMtime(nodeFs, dir)).toBeGreaterThan(0)
  })
})

describe("isInside", () => {
  test("with real paths: a link that leaves the folder is not inside", async () => {
    const root = join(tmp, "contain")
    mkdirSync(join(root, "a"), { recursive: true })
    writeFileSync(join(tmp, "fuera.md"), "secreto")
    symlinkSync(join(tmp, "fuera.md"), join(root, "a", "enlace.md"))
    writeFileSync(join(root, "a", "dentro.md"), "ok")
    expect(await isInside(root, join(root, "a", "dentro.md"))).toBe(true)
    expect(await isInside(root, join(root, "a", "no-existe.md"))).toBe(true)
    expect(await isInside(root, join(root, "a", "enlace.md"))).toBe(false)
    expect(await isInside(root, "/etc/hosts")).toBe(false)
    expect(await isInside(root, join(root, "..", "fuera.md"))).toBe(false)
    expect(await isInside(root, root)).toBe(false)
    expect(await isInside(root, root, { orSame: true })).toBe(true)
  })

  test("/tmp and /private/tmp are the same folder", async () => {
    if (process.platform !== "darwin") return
    const root = mkdtempSync("/tmp/openspec-status-inside-")
    try {
      writeFileSync(join(root, "f.md"), "x")
      expect(await isInside(root, join("/private", root, "f.md"))).toBe(true)
      expect(await isInside(join("/private", root), join(root, "f.md"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
