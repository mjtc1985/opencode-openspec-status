// Jump to new work: if during a session an SDD change (`openspec/changes/<x>/`) or
// an ODD feature (`odd/tasks/<x>.md`) appears that the session had never seen, the
// sidebar pins it with `origin: "new"` (it says «new»). Only on creation: editing
// what already existed does not jump, and neither does a name that disappears and
// comes back (e.g. when switching branches), because what was seen only grows.
//
// What was seen is kept in memory, per session (never in the KV): the first read
// of each source with the session in front is its starting point and does not jump.
// Without a session (home screen) nothing is watched. What appears with a session in
// front belongs to that session: the others count it as seen and do not jump when
// you go back to them (a session's starting point, on the other hand, does not
// count for the others). Names and dates come from reads the poller already does
// (`stampedChanges` and `listOddDocs`). No opentui.

import type { Pin, PinKind } from "../sources/choice.ts"
import { type Fsx, nodeFs } from "../sources/exec.ts"
import { readGitInfo } from "../sources/sdd-detail.ts"

/** A listed change or feature and its last modification (ms epoch; 0 if unknown). */
export type Stamped = { name: string; updatedAt: number }
/** What a poll listed; a source not read in that poll is absent. */
export type Listing = { sdd?: readonly Stamped[]; odd?: readonly Stamped[] }
export type NewWork = { kind: PinKind; name: string }

const KINDS: readonly PinKind[] = ["sdd", "odd"]
const seenKey = (kind: PinKind, name: string) => `${kind}:${name}`

/**
 * What in `current` is not in `seen` (keys `sdd:<name>` / `odd:<name>`). If there
 * are several, the most recently modified; a tie between SDD and ODD goes to SDD.
 */
export function detectNew(seen: ReadonlySet<string>, current: Listing): NewWork | undefined {
  let best: (NewWork & { updatedAt: number }) | undefined
  for (const kind of KINDS) {
    for (const item of current[kind] ?? []) {
      if (seen.has(seenKey(kind, item.name))) continue
      if (!best || item.updatedAt > best.updatedAt) best = { kind, name: item.name, updatedAt: item.updatedAt }
    }
  }
  return best && { kind: best.kind, name: best.name }
}

export type NewWorkTracker = {
  /** Records what was listed with `session` in front and returns what is new for it, if anything. */
  observe(session: string | undefined, listing: Listing): NewWork | undefined
}

type SessionSeen = { seen: Set<string>; ready: Set<PinKind> }

export function createNewWorkTracker(): NewWorkTracker {
  const sessions = new Map<string, SessionSeen>()
  return {
    observe(session, listing) {
      if (session === undefined) return undefined
      let own = sessions.get(session)
      if (!own) {
        own = { seen: new Set(), ready: new Set() }
        sessions.set(session, own)
      }
      // Only sources this session had already read count: the first read of
      // each one is the starting point.
      const known: Listing = {}
      for (const kind of KINDS) if (listing[kind] && own.ready.has(kind)) known[kind] = listing[kind]
      const found = detectNew(own.seen, known)
      for (const kind of KINDS) {
        const items = listing[kind]
        if (!items) continue
        // What appears with this session in front also counts as seen for the
        // others that already had a starting point. This one's starting point does
        // not count for the others: what was there did not appear here.
        const targets = known[kind] ? [...sessions.values()].filter((s) => s === own || s.ready.has(kind)) : [own]
        for (const s of targets) for (const item of items) s.seen.add(seenKey(kind, item.name))
        own.ready.add(kind)
      }
      return found
    },
  }
}

export type NewWorkPinnerOptions = {
  root: string
  fsx?: Fsx
  /** The session shown now (`undefined` on the home screen). */
  session: () => string | undefined
  /** Writes that session's pin (in the KV, with the same rule as Enter). */
  write: (session: string, pin: Pin) => void
  tracker?: NewWorkTracker
}

/**
 * `onListed` for the poller: if there is something new for the current session,
 * pins it for that session on the current branch (`.git/HEAD`) with `origin: "new"`
 * and returns `true` (the pin changed). Never throws.
 */
export function createNewWorkPinner(options: NewWorkPinnerOptions): (listing: Listing) => Promise<boolean> {
  const fsx = options.fsx ?? nodeFs
  const tracker = options.tracker ?? createNewWorkTracker()
  return async (listing) => {
    const session = options.session()
    const found = tracker.observe(session, listing)
    if (!found || session === undefined) return false
    const { branch } = await readGitInfo(options.root, fsx).catch(() => ({ branch: undefined }))
    options.write(session, { kind: found.kind, name: found.name, branch: branch ?? "", origin: "new" })
    return true
  }
}
