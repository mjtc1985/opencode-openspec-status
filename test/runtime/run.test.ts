import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { bunSpawn, childEnv, createRun, fallbackDirs, resolveExecutable, searchPath, type Spawn } from "../../src/runtime/run.ts"
import { gitStatusArgs, reviewStatusArgs, sddStatusArgs } from "../../src/sources/exec.ts"

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-run-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function spySpawn(out = "") {
  const calls: { file: string; args: string[]; cwd: string; env: Record<string, string | undefined>; timeoutMs: number; maxBytes: number }[] = []
  const spawn: Spawn = async (file, args, opts) => {
    calls.push({ file, args, ...opts })
    return out
  }
  return { spawn, calls }
}

describe("allowlist", () => {
  const forbidden: [string, string[]][] = [
    ["gentle-ai", ["review", "start", "--cwd", "/p"]],
    ["gentle-ai", ["review", "status", "--cwd", "/p", "--consent=relay"]],
    ["gentle-ai", ["review", "assess", "--cwd", "/p", "--json"]],
    ["gentle-ai", ["sdd-continue", "x"]],
    ["gentle-ai", ["review", "mode", "disable"]],
    ["git", ["init"]],
    ["git", ["status", "--porcelain"]],
    ["rm", ["-rf", "/"]],
  ]
  for (const [cmd, args] of forbidden) {
    test(`rejects ${cmd} ${args.join(" ")} without looking up or running anything`, async () => {
      const { spawn, calls } = spySpawn()
      let resolved = 0
      const run = createRun({ spawn, resolve: () => (resolved++, "/bin/echo") })
      await expect(run(cmd as "git", args, { cwd: tmp })).rejects.toThrow("comando no permitido")
      expect(calls).toHaveLength(0)
      expect(resolved).toBe(0)
    })
  }

  test("lets the exact read-only forms through, as argv and without a shell", async () => {
    const { spawn, calls } = spySpawn("{}")
    const run = createRun({ spawn, resolve: (name) => `/opt/bin/${name}`, path: "/x" })
    await run("gentle-ai", sddStatusArgs("/p"), { cwd: "/p" })
    await run("gentle-ai", reviewStatusArgs("/p"), { cwd: "/p" })
    await run("git", gitStatusArgs(), { cwd: "/p" })
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([
      ["/opt/bin/gentle-ai", "sdd-status", "--json", "--cwd", "/p"],
      ["/opt/bin/gentle-ai", "review", "status", "--cwd", "/p"],
      ["/opt/bin/git", "--no-optional-locks", "status", "--porcelain"],
    ])
    expect(calls[0]!.cwd).toBe("/p")
    expect(calls[0]!.env.PATH).toBe("/x")
    expect(calls[0]!.timeoutMs).toBe(5_000)
    expect(calls[0]!.maxBytes).toBe(2 * 1024 * 1024)
  })
})

describe("executables", () => {
  test("no executable: clear error and nothing runs", async () => {
    const { spawn, calls } = spySpawn()
    const run = createRun({ spawn, resolve: () => undefined })
    await expect(run("gentle-ai", sddStatusArgs("/p"), { cwd: "/p" })).rejects.toThrow("gentle-ai no encontrado")
    expect(calls).toHaveLength(0)
  })

  test("the lookup PATH adds the fallback folders without duplicates", () => {
    const path = searchPath(["/usr/bin", "/opt/homebrew/bin"].join(delimiter), "/Users/ana")
    expect(path.split(delimiter)).toEqual(["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Users/ana/.local/bin", "/Users/ana/go/bin", "/bin"])
    expect(fallbackDirs("/h")).toContain("/h/go/bin")
  })

  test("the PATH keeps only absolute entries: a project bin/ never runs", () => {
    const path = searchPath(["bin", ".", "", "node_modules/.bin", "/usr/bin", "./x"].join(delimiter), "/Users/ana")
    expect(path.split(delimiter)).toEqual(["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Users/ana/.local/bin", "/Users/ana/go/bin", "/bin"])
  })

  test("createRun also filters an explicit PATH and passes it that way to the child", async () => {
    const { spawn, calls } = spySpawn()
    const seen: string[] = []
    const which = (name: string, o: { PATH: string }) => (seen.push(o.PATH), `/usr/bin/${name}`)
    const run = createRun({ spawn, path: ["relbin", "/usr/bin", "."].join(delimiter), resolve: (name) => resolveExecutable(name, undefined, which) })
    await run("git", gitStatusArgs(), { cwd: tmp })
    expect(calls[0]!.env.PATH).toBe("/usr/bin")
  })

  test("resolveExecutable looks up with that PATH", () => {
    const seen: string[] = []
    const which = (name: string, o: { PATH: string }) => (seen.push(o.PATH), name === "git" ? "/usr/bin/git" : null)
    expect(resolveExecutable("git", "/a:/b", which)).toBe("/usr/bin/git")
    expect(resolveExecutable("gentle-ai", "/a:/b", which)).toBeUndefined()
    expect(seen).toEqual(["/a:/b", "/a:/b"])
  })

  test("real git: found even when the process PATH is empty", () => {
    expect(resolveExecutable("git", searchPath("", process.env.HOME))).toMatch(/\/git$/)
  })

  test("if spawn fails, the next attempt looks the executable up again", async () => {
    let resolved = 0
    const spawn: Spawn = async () => {
      throw new Error("ENOENT")
    }
    const run = createRun({ spawn, resolve: () => (resolved++, "/nada/git") })
    await expect(run("git", gitStatusArgs(), { cwd: tmp })).rejects.toThrow("git status: ENOENT")
    await expect(run("git", gitStatusArgs(), { cwd: tmp })).rejects.toThrow()
    expect(resolved).toBe(2)
  })
})

describe("child environment", () => {
  test("core.fsmonitor=false through GIT_CONFIG_*, after any existing entries", () => {
    const env = childEnv({ HOME: "/h", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Ana" }, "/usr/bin")
    expect(env).toEqual({
      HOME: "/h",
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Ana",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    })
    expect(childEnv({ GIT_CONFIG_COUNT: "basura" }, "/b")).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" })
  })

  test("createRun passes it to every spawn", async () => {
    const { spawn, calls } = spySpawn()
    await createRun({ spawn, resolve: () => "/usr/bin/git", path: "/usr/bin" })("git", gitStatusArgs(), { cwd: tmp })
    const env = calls[0]!.env
    const n = Number(env.GIT_CONFIG_COUNT) - 1
    expect([env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]]).toEqual(["core.fsmonitor", "false"])
  })

  test("real git status does not run the core.fsmonitor from the repo's .git/config", async () => {
    const repo = join(tmp, "fsmonitor")
    spawnSync("git", ["init", "-q", repo])
    const marker = join(tmp, "fsmonitor-ejecutado")
    const hook = join(tmp, "fsmonitor-hook.sh")
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(hook, 0o755)
    spawnSync("git", ["-C", repo, "config", "core.fsmonitor", hook])
    await createRun()("git", gitStatusArgs(), { cwd: repo })
    expect(existsSync(marker)).toBe(false)
    // Control: without the hardened environment git does run it (otherwise the test proves nothing).
    spawnSync("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: repo })
    expect(existsSync(marker)).toBe(true)
  })
})

describe("real process", () => {
  test("git --no-optional-locks status --porcelain in a temporary repo", async () => {
    const repo = join(tmp, "repo")
    spawnSync("git", ["init", "-q", repo])
    writeFileSync(join(repo, "a.txt"), "hola\n")
    const out = await createRun()("git", gitStatusArgs(), { cwd: repo })
    expect(out).toContain("?? a.txt")
  })

  test("timeout: kills the process and rejects", async () => {
    const start = Date.now()
    await expect(bunSpawn("/bin/sleep", ["10"], { cwd: tmp, env: process.env, timeoutMs: 150, maxBytes: 1024 })).rejects.toThrow("superó")
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  test("timeout with a descendant holding stdout open: kills the group and rejects right away", async () => {
    const marker = join(tmp, "descendiente-vivo")
    const start = Date.now()
    const script = `(sleep 0.8; touch '${marker}') & sleep 6 & echo hola; sleep 30`
    await expect(bunSpawn("/bin/sh", ["-c", script], { cwd: tmp, env: process.env, timeoutMs: 300, maxBytes: 1024 })).rejects.toThrow("superó 300 ms")
    // Without the process group it took as long as the `sleep 30`; plenty of margin for load.
    expect(Date.now() - start).toBeLessThan(2_000)
    await Bun.sleep(900)
    expect(existsSync(marker)).toBe(false)
  })

  test("output too large: kills the group and rejects without waiting for the end", async () => {
    // 64 KB at once against a 1 KB cap; the `sleep` proves the child is not awaited.
    const start = Date.now()
    const script = "head -c 65536 /dev/zero; sleep 30"
    await expect(bunSpawn("/bin/sh", ["-c", script], { cwd: tmp, env: process.env, timeoutMs: 10_000, maxBytes: 1024 })).rejects.toThrow("salida demasiado grande")
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  test("non-zero exit code: rejects with the first stderr line", async () => {
    await expect(bunSpawn("/usr/bin/git", ["--no-optional-locks", "status", "--porcelain"], { cwd: "/", env: process.env, timeoutMs: 3_000, maxBytes: 10_000 })).rejects.toThrow(
      /salió con código 128: fatal:/,
    )
  })
})
