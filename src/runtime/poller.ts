// Background polling of the four sources. Each source has its own interval and
// never overlaps itself; if a read fails the last known value is kept and marked
// `stale` from the first failure until the next success. `onChange` only fires
// when the `Snapshot` really changes. With `onListed`, SDD and ODD first list their
// changes and documents (the same ones they read anyway) to detect new work,
// before reading their state.

import { join } from "node:path"
import { t } from "../i18n.ts"
import type { Snapshot, Sourced } from "../model.ts"
import { type Pin, isValidOddName } from "../sources/choice.ts"
import { type Fsx, type Run, isInside, nodeFs } from "../sources/exec.ts"
import { loadGit } from "../sources/git.ts"
import { listOddDocs, loadOdd, oddDocName } from "../sources/odd.ts"
import { createReviewLoader } from "../sources/review.ts"
import { loadSdd, stampedChanges } from "../sources/sdd.ts"
import type { Listing } from "./new-work.ts"

export type SourceKey = "sdd" | "odd" | "review" | "git"
export const SOURCE_KEYS: readonly SourceKey[] = ["sdd", "odd", "review", "git"]

export type Intervals = Record<SourceKey, number>
export const DEFAULT_INTERVALS: Intervals = { sdd: 3_000, odd: 3_000, review: 10_000, git: 3_000 }

export type Timers = {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

export type PollerOptions = {
  root: string
  run: Run
  fsx?: Fsx
  now?: () => number
  timers?: Timers
  intervals?: Partial<Intervals>
  /** Maximum time for a read before it is considered hung (default `WATCHDOG_MS`). */
  watchdogMs?: number
  /** What was pinned, SDD change or ODD feature (OpenCode KV); checked on every SDD and ODD read. */
  pin?: () => Pin | undefined
  /**
   * What each SDD read (active changes) or ODD read (`odd/tasks/` documents) lists,
   * before reading its state. Returning `true` means the pin changed: the current
   * read already sees it and the other source is read again. Throwing counts as
   * `false`.
   */
  onListed?: (listing: Listing) => boolean | Promise<boolean>
  onChange?: (snapshot: Snapshot) => void
}

export type Poller = {
  snapshot(): Snapshot
  /** Reads every source now; joins reads already in progress. */
  refresh(): Promise<void>
  dispose(): void
}

export function emptySnapshot(root: string): Snapshot {
  return { root, sdd: { value: { kind: "none" } }, odd: { value: { kind: "none" } }, review: { value: { kind: "none" } }, git: { value: { kind: "none" } } }
}

/**
 * A read that never finishes (e.g. an fs promise Bun never resolves) would block
 * the source forever: after this long it is considered failed, the source is
 * marked stale and the next poll tries again. Generous compared with the 5 s
 * timeout of each command.
 */
export const WATCHDOG_MS = 30_000

function withWatchdog<T>(p: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(t("poller.hung", { duration: ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms` }))), ms)
  })
  const clear = () => clearTimeout(handle)
  p.then(clear, clear)
  return Promise.race([p, timeout])
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)) || t("error.unknown")

/** Starts its timers when created; the first read is requested by the caller with `refresh()`. */
export function createPoller(options: PollerOptions): Poller {
  const { root, run } = options
  const fsx = options.fsx ?? nodeFs
  const now = options.now ?? Date.now
  const timers = options.timers ?? realTimers
  const intervals = { ...DEFAULT_INTERVALS, ...options.intervals }
  const watchdogMs = options.watchdogMs ?? WATCHDOG_MS
  const review = createReviewLoader(fsx)

  const pinned = options.pin ? { pin: options.pin } : {}
  const onListed = options.onListed
  /** Reports what was listed; if the pin changed, reads `other` again. */
  const listed = async (listing: Listing, other: SourceKey) => {
    let changed = false
    try {
      changed = (await onListed?.(listing)) === true
    } catch {
      changed = false
    }
    if (changed) rerun(other)
  }
  const loaders: { [K in SourceKey]: () => Promise<Snapshot[K]["value"]> } = {
    sdd: async () => {
      if (!onListed) return loadSdd(root, run, fsx, pinned)
      const changes = await stampedChanges(root, fsx)
      await listed({ sdd: changes.map((c) => ({ name: c.name, updatedAt: c.mtime })) }, "odd")
      return loadSdd(root, run, fsx, { ...pinned, changes })
    },
    odd: async () => {
      if (!onListed) return loadOdd(root, fsx, pinned)
      const docs = await listOddDocs(root, fsx)
      // Only pinnable ones: safe name and, once resolved, inside `odd/tasks/`.
      const dir = join(root, "odd", "tasks")
      const odd = (
        await Promise.all(
          docs.map(async (d) => (isValidOddName(oddDocName(d)) && (await isInside(dir, join(dir, d.name))) ? [{ name: oddDocName(d), updatedAt: d.mtime }] : [])),
        )
      ).flat()
      await listed({ odd }, "sdd")
      return loadOdd(root, fsx, { ...pinned, docs })
    },
    review: () => review.load(root, run),
    git: () => loadGit(root, run, fsx),
  }

  let current = emptySnapshot(root)
  let emitted = JSON.stringify(current)
  let disposed = false
  const inflight = new Map<SourceKey, Promise<void>>()
  /** Sources to read again as soon as the read in progress finishes. */
  const again = new Set<SourceKey>()

  function update<K extends SourceKey>(key: K, next: Sourced<Snapshot[K]["value"]>) {
    current = { ...current, [key]: next }
    const serialized = JSON.stringify(current)
    if (serialized === emitted) return
    emitted = serialized
    options.onChange?.(current)
  }

  async function load<K extends SourceKey>(key: K): Promise<void> {
    try {
      const value = await withWatchdog(loaders[key](), watchdogMs)
      if (!disposed) update(key, { value } as Sourced<Snapshot[K]["value"]>)
    } catch (err) {
      if (disposed) return
      const prev = current[key]
      update(key, { value: prev.value, stale: { since: prev.stale?.since ?? now(), error: message(err) } } as Sourced<Snapshot[K]["value"]>)
    }
  }

  function tick(key: SourceKey): Promise<void> {
    if (disposed) return Promise.resolve()
    const running = inflight.get(key)
    if (running) return running
    const p = load(key).finally(() => {
      inflight.delete(key)
      if (again.delete(key)) void tick(key)
    })
    inflight.set(key, p)
    return p
  }

  /** Reads `key` now or, if it is reading, as soon as it finishes (that read may predate the change). */
  function rerun(key: SourceKey) {
    if (inflight.has(key)) again.add(key)
    else void tick(key)
  }

  const handles = SOURCE_KEYS.map((key) => timers.setInterval(() => void tick(key), intervals[key]))

  return {
    snapshot: () => current,
    refresh: async () => {
      await Promise.all(SOURCE_KEYS.map(tick))
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const h of handles) timers.clearInterval(h)
    },
  }
}
