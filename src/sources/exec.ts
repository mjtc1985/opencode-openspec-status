// Commands the sources may run and the file IO they use. The runtime injects
// `Run` and checks `isAllowed` before spawning anything: read-only.

import { constants } from "node:fs"
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

/** Resolves with stdout; rejects when the command fails or times out. */
export type Run = (cmd: "gentle-ai" | "git", args: string[], opts: { cwd: string }) => Promise<string>

export const REVIEW_CONTRACT_V2 = "gentle-ai.review-integration/v2"

/**
 * The executable is not installed (or not found anywhere). Sources use it to
 * degrade gracefully: SDD falls back to the OpenSpec files and the review section
 * is hidden, instead of showing an error.
 */
export class CommandNotFoundError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message)
    this.name = "CommandNotFoundError"
  }
}

export function sddStatusArgs(root: string, change?: string): string[] {
  return ["sdd-status", ...(change ? [change] : []), "--json", "--cwd", root]
}

export function reviewStatusArgs(root: string): string[] {
  return ["review", "status", "--cwd", root]
}

export function reviewLineageArgs(root: string, lineage: string): string[] {
  return ["review", "status", "--cwd", root, `--contract=${REVIEW_CONTRACT_V2}`, "--next-transition=true", `--lineage=${lineage}`]
}

export function gitStatusArgs(): string[] {
  return ["--no-optional-locks", "status", "--porcelain"]
}

// Words that reveal a state-changing operation, wherever they appear.
const FORBIDDEN = /^(start|recover|repair|mode|capture-.*|--consent(=.*)?)$/

const isValue = (s: string | undefined): s is string => typeof s === "string" && s.length > 0 && !s.startsWith("-")
const LINEAGE = /^--lineage=[A-Za-z0-9._-]+$/

/**
 * Can it be passed as `<change>` to `sdd-status`? Same rules as `isAllowed`: a
 * folder `openspec/changes/--help` or `start` is never queried (and never stalls polling).
 */
export function isValidChangeName(name: string): boolean {
  return isValue(name) && !FORBIDDEN.test(name)
}

/** true only for the exact shapes above. */
export function isAllowed(cmd: string, args: readonly string[]): boolean {
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) return false
  if (cmd === "git") {
    const want = gitStatusArgs()
    return args.length === want.length && args.every((a, i) => a === want[i])
  }
  if (cmd !== "gentle-ai") return false
  if (args.some((a) => FORBIDDEN.test(a))) return false

  if (args[0] === "sdd-status") {
    // sdd-status [change] --json --cwd <root>
    const rest = args.length === 5 && isValidChangeName(args[1]!) ? args.slice(2) : args.slice(1)
    return rest.length === 3 && rest[0] === "--json" && rest[1] === "--cwd" && isValue(rest[2])
  }
  if (args[0] === "review" && args[1] === "status" && args[2] === "--cwd" && isValue(args[3])) {
    if (args.length === 4) return true
    return (
      args.length === 7 &&
      args[4] === `--contract=${REVIEW_CONTRACT_V2}` &&
      args[5] === "--next-transition=true" &&
      LINEAGE.test(args[6]!)
    )
  }
  return false
}

// ── Files ───────────────────────────────────────────────────────────────────

/** Read caps: a larger file is not what we expect and is treated as missing. */
export const MAX_MARKDOWN_BYTES = 512 * 1024
export const MAX_GIT_BYTES = 64 * 1024
/** A real `review-state.json` is ~60 KB. */
export const MAX_STATE_BYTES = 4 * 1024 * 1024

export type ReadOptions = { maxBytes?: number }

/** File IO for the sources. Never throws: failures are `undefined` or `[]`. */
export type Fsx = {
  mtime(path: string): Promise<number | undefined>
  /** Regular files only, up to `maxBytes` (default `MAX_MARKDOWN_BYTES`). */
  readText(path: string, options?: ReadOptions): Promise<string | undefined>
  /** Real directories and regular files (or links to one); no FIFOs, devices or links to directories. */
  listDir(path: string): Promise<{ name: string; dir: boolean }[]>
  exists(path: string): Promise<boolean>
}

/**
 * Bounded read: opens non-blocking (a FIFO never waits for a writer), checks with
 * `fstat` that it is a regular file within the cap and reads at most that. A
 * committed link to `/dev/zero` or a FIFO yields `undefined`.
 */
async function readBounded(path: string, maxBytes: number): Promise<string | undefined> {
  let fh: FileHandle | undefined
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const st = await fh.stat()
    if (!st.isFile() || st.size > maxBytes) return undefined
    const buf = Buffer.alloc(st.size)
    let len = 0
    while (len < buf.length) {
      const { bytesRead } = await fh.read(buf, len, buf.length - len, len)
      if (bytesRead === 0) break
      len += bytesRead
    }
    return buf.subarray(0, len).toString("utf8")
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

export const nodeFs: Fsx = {
  async mtime(path) {
    try {
      return (await stat(path)).mtimeMs
    } catch {
      return undefined
    }
  },
  readText(path, options) {
    return readBounded(path, options?.maxBytes ?? MAX_MARKDOWN_BYTES)
  },
  async listDir(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      const out: { name: string; dir: boolean }[] = []
      for (const e of entries) {
        if (e.isDirectory()) out.push({ name: e.name, dir: true })
        else if (e.isFile()) out.push({ name: e.name, dir: false })
        else if (e.isSymbolicLink()) {
          // A link only counts if it points to a regular file; directories are not followed.
          const target = await stat(join(path, e.name)).catch(() => undefined)
          if (target?.isFile()) out.push({ name: e.name, dir: false })
        }
      }
      return out
    } catch {
      return []
    }
  },
  async exists(path) {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
}

// ── Containment ─────────────────────────────────────────────────────────────

/** Real path; if it does not exist, the real path of its closest ancestor plus the rest. */
async function canonical(p: string): Promise<string> {
  const abs = resolve(p)
  try {
    return await realpath(abs)
  } catch {
    const parent = dirname(abs)
    return parent === abs ? abs : join(await canonical(parent), basename(abs))
  }
}

/**
 * Is `child` inside `dir`? Uses real paths: resolves links and /tmp → /private/tmp
 * (gentle-ai may report one form and the root the other). `orSame`: `child` may be `dir`.
 */
export async function isInside(dir: string, child: string, options: { orSame?: boolean } = {}): Promise<boolean> {
  const rel = relative(await canonical(dir), await canonical(child))
  if (rel === "") return options.orSame === true
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Newest mtime of any file under `dir` (bounded depth). */
export async function newestMtime(fsx: Fsx, dir: string, depth = 4): Promise<number> {
  let best = 0
  for (const e of await fsx.listDir(dir)) {
    const p = join(dir, e.name)
    const m = e.dir ? (depth > 0 ? await newestMtime(fsx, p, depth - 1) : 0) : ((await fsx.mtime(p)) ?? 0)
    if (m > best) best = m
  }
  return best
}

/** Plain JSON object (neither `null` nor an array). */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** JSON from a command's output; `undefined` if it is not JSON. */
export function parseJson(out: string): unknown {
  try {
    return JSON.parse(out)
  } catch {
    return undefined
  }
}
