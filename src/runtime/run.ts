// The real `Run`: spawns `gentle-ai` or `git` without a shell (argv), with a
// timeout, an output cap and the `isAllowed` allowlist checked right before every
// spawn. OpenCode may start with a trimmed PATH: executables are looked up in the
// process PATH and then in the usual install folders. Children run inside the
// project (which may be hostile): PATH with absolute entries only,
// `core.fsmonitor` off and their own process group so the timeout also kills
// grandchildren.

import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { locale, t } from "../i18n.ts"
import { CommandNotFoundError, type Run, isAllowed } from "../sources/exec.ts"

export const TIMEOUT_MS = 5_000
export const MAX_STDOUT_BYTES = 2 * 1024 * 1024
const MAX_STDERR_BYTES = 4 * 1024

export type Command = Parameters<Run>[0]

/** Folders where `gentle-ai` and `git` usually live outside OpenCode's PATH. */
export function fallbackDirs(home = homedir()): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, "go", "bin"), "/usr/bin", "/bin"]
}

/** Absolute entries only: `bin` or `node_modules/.bin` would resolve inside the project. */
function absoluteOnly(dirs: string[]): string[] {
  return [...new Set(dirs.filter((d) => d !== "" && isAbsolute(d)))]
}

/** Process PATH plus the fallback folders, without duplicates or relative entries. */
export function searchPath(pathEnv = process.env.PATH ?? "", home = homedir()): string {
  return absoluteOnly([...pathEnv.split(delimiter), ...fallbackDirs(home)]).join(delimiter)
}

type Env = Record<string, string | undefined>

/**
 * Child environment: the process one with `PATH` and `core.fsmonitor=false` (git
 * runs the repository's `.git/config` fsmonitor on every `status`, including the
 * one gentle-ai spawns). Set through `GIT_CONFIG_*`, after any existing entries.
 */
export function childEnv(parent: Env, path: string): Env {
  const raw = parent.GIT_CONFIG_COUNT
  const count = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0
  return {
    ...parent,
    PATH: path,
    [`GIT_CONFIG_KEY_${count}`]: "core.fsmonitor",
    [`GIT_CONFIG_VALUE_${count}`]: "false",
    GIT_CONFIG_COUNT: String(count + 1),
  }
}

export type Which = (name: string, options: { PATH: string }) => string | null

/** Absolute path of the executable, or `undefined` if it is nowhere to be found. */
export function resolveExecutable(name: Command, path = searchPath(), which: Which = Bun.which): string | undefined {
  return which(name, { PATH: path }) ?? undefined
}

/** Spawns `file args` and resolves with stdout. Rejects on failure, timeout or overflow. */
export type Spawn = (file: string, args: string[], opts: { cwd: string; env: Env; timeoutMs: number; maxBytes: number }) => Promise<string>

/** Reads a stream to the end; past `max` bytes it notifies and stops buffering. */
async function collect(reader: ReadableStreamDefaultReader<Uint8Array>, max: number, onOverflow: () => void): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  let over = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (over) continue
    size += value.byteLength
    if (size > max) {
      over = true
      onOverflow()
      continue
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

type KillFn = (pid: number, signal: number) => number
let libcKill: KillFn | null | undefined

/** libc `kill(2)` through FFI: `process.kill` in some Bun versions rejects negative (group) pids. */
function loadLibcKill(): KillFn | null {
  if (libcKill !== undefined) return libcKill
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi")
    const lib = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", { kill: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
    libcKill = lib.symbols.kill as KillFn
  } catch {
    libcKill = null
  }
  return libcKill
}

const SIGKILL = 9

/**
 * SIGKILL to the `pid` group (the child spawned `detached` and its descendants).
 * If that fails, `fallback` (the child only). Never with pid ≤ 1: `kill(-0)` would
 * be our own group.
 */
export function killGroup(pid: number, fallback: () => void): void {
  if (!Number.isInteger(pid) || pid <= 1) return fallback()
  try {
    process.kill(-pid, "SIGKILL")
    return
  } catch {}
  try {
    if (loadLibcKill()?.(-pid, SIGKILL) === 0) return
  } catch {}
  fallback()
}

/** «300 ms», «5 s», «2.5 s» (Spanish: «2,5 s»). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms % 1000 === 0) return `${ms / 1000} s`
  const n = (ms / 1000).toFixed(1)
  return `${locale() === "es" ? n.replace(".", ",") : n} s`
}

export const bunSpawn: Spawn = async (file, args, opts) => {
  // `detached`: its own process group, so descendants can be killed too.
  const proc = Bun.spawn([file, ...args], { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
  const out = proc.stdout.getReader()
  const err = proc.stderr.getReader()
  let failure: string | undefined
  let abort: (e: Error) => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    abort = reject
  })
  aborted.catch(() => {})
  // A grandchild may keep stdout open after the child dies: kill the group and
  // reject right away, without waiting for the streams to end.
  const kill = (reason: string) => {
    if (failure) return
    failure = reason
    killGroup(proc.pid, () => proc.kill("SIGKILL"))
    abort(new Error(reason))
  }
  const timer = setTimeout(() => kill(t("run.timeout", { duration: formatDuration(opts.timeoutMs) })), opts.timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([collect(out, opts.maxBytes, () => kill(t("run.tooMuchOutput"))), collect(err, MAX_STDERR_BYTES, () => {}), proc.exited]),
      aborted,
    ])
    if (failure) throw new Error(failure)
    if (code !== 0) {
      const detail = stderr.trim().split(/\r?\n/)[0]
      throw new Error(t("run.exitCode", { code: String(code) }) + (detail ? `: ${detail}` : ""))
    }
    return stdout
  } finally {
    clearTimeout(timer)
    out.cancel().catch(() => {})
    err.cancel().catch(() => {})
  }
}

export type RunOptions = {
  timeoutMs?: number
  maxBytes?: number
  spawn?: Spawn
  resolve?: (name: Command) => string | undefined
  /** PATH passed to the child (gentle-ai spawns git too). Relative entries are dropped. */
  path?: string
}

/** «gentle-ai sdd-status», «gentle-ai review status», «git status». */
function label(cmd: Command, args: string[]): string {
  if (cmd === "git") return "git status"
  return args[0] === "review" ? "gentle-ai review status" : `gentle-ai ${args[0]}`
}

/** The `Run` the plugin uses. Never spawns anything that fails `isAllowed`. */
export function createRun(options: RunOptions = {}): Run {
  const path = absoluteOnly((options.path ?? searchPath()).split(delimiter)).join(delimiter)
  const resolve = options.resolve ?? ((name: Command) => resolveExecutable(name, path))
  const spawn = options.spawn ?? bunSpawn
  const found = new Map<Command, string>()

  return async (cmd, args, opts) => {
    if (!isAllowed(cmd, args)) throw new Error(t("run.notAllowed", { command: `${cmd} ${args.join(" ")}` }))
    const file = found.get(cmd) ?? resolve(cmd)
    if (!file) throw new CommandNotFoundError(cmd, t("run.notFound", { command: cmd }))
    found.set(cmd, file)
    try {
      return await spawn(file, [...args], {
        cwd: opts.cwd,
        env: childEnv(process.env, path),
        timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
        maxBytes: options.maxBytes ?? MAX_STDOUT_BYTES,
      })
    } catch (err) {
      // If the executable disappeared, it is looked up again next time.
      found.delete(cmd)
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${label(cmd, args)}: ${message}`)
    }
  }
}
