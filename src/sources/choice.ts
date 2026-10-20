// Which SDD change the sidebar shows when several are active, which ODD document
// goes with the branch, and what was pinned by hand (the focus). Change order:
// (1) the one pinned in `/openspec-status` for this project and branch, if it
// still exists; (2) the branch's: its work item equals a change's `workItem` in
// `.openspec.yaml`, or the branch contains the change name; (3) the most recent.
// The choice is pure; `readCandidates` is the only reader (each change's
// `.openspec.yaml`, bounded and inside the root).

import { join } from "node:path"
import type { BranchMatch } from "../model.ts"
import { type Fsx, MAX_GIT_BYTES, isInside, isValidChangeName, nodeFs } from "./exec.ts"
import { type GitInfo, type GitRemote, type WorkItem, branchWorkItem, detectWorkItem, parseOpenspecYaml } from "./sdd-detail.ts"

/**
 * What was pinned in `/openspec-status`: the sidebar's focus. An SDD change or an
 * ODD feature (`name` is the `odd/tasks/` document name without `.md`); only valid
 * while the branch is `branch` (`""` without a branch). One per session: pinning
 * another replaces it. `origin`: `new` when the plugin pinned it because that
 * change or feature was started during the session (the sidebar says «new»);
 * without `origin`, by hand.
 */
export type PinKind = "sdd" | "odd"
export type PinOrigin = "manual" | "new"
export type Pin = { kind: PinKind; name: string; branch: string; origin?: PinOrigin }
export type ChoiceReason = "pinned" | "branch" | "recent"
/** An active change with the work item declared in its `.openspec.yaml`. */
export type Candidate = { name: string; workItem?: WorkItem }

/** Key of the pin in OpenCode's KV: one per project (real root path) and session. */
export const pinKey = (realRoot: string, sessionId: string) => `openspec-status:pin:${realRoot}:${sessionId}`

const MAX_BRANCH = 1024
export const MAX_ODD_NAME = 200

/**
 * Is it a safe ODD document name (`<name>.md` inside `odd/tasks/`)? No separators,
 * no `..`, no control characters, not starting with `.` or `-`, bounded length.
 * It is always resolved inside that folder, with `isInside`.
 */
export function isValidOddName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_ODD_NAME) return false
  if (name.startsWith(".") || name.startsWith("-") || name.includes("..")) return false
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || c === 0x2f || c === 0x5c) return false
  }
  return true
}

/**
 * Validates whatever comes from the KV (anyone may have edited it). Accepts the
 * older shape `{ change, branch }` as an SDD pin. `origin` is only kept when it
 * is `new` or `manual`; any other value counts as manual.
 */
export function parsePin(value: unknown): Pin | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const { branch } = v
  if (typeof branch !== "string" || branch.length > MAX_BRANCH) return undefined
  const kind = v.kind === undefined && "change" in v ? "sdd" : v.kind
  const name = v.kind === undefined ? v.change : v.name
  if (typeof name !== "string") return undefined
  const origin: { origin?: PinOrigin } = v.origin === "new" || v.origin === "manual" ? { origin: v.origin } : {}
  if (kind === "sdd" && isValidChangeName(name)) return { kind, name, branch, ...origin }
  if (kind === "odd" && isValidOddName(name)) return { kind, name, branch, ...origin }
  return undefined
}

/** The pinned name of that kind if the pin belongs to this branch and still exists (is in `names`). */
export function activePin(pin: Pin | undefined, kind: PinKind, branch: string | undefined, names: readonly string[]): string | undefined {
  if (!pin || pin.kind !== kind || pin.branch !== (branch ?? "") || !names.includes(pin.name)) return undefined
  return pin.name
}

/** Did the plugin pin it because it is new in the session? (The sidebar says «new» instead of «pinned».) */
export const isNewPin = (pin: Pin | undefined): boolean => pin?.origin === "new"

/**
 * Enter on `name`: pins it by hand for this branch (replacing whatever was pinned,
 * automatic or not); if it already was the pin, releases it.
 */
export function togglePin(pin: Pin | undefined, kind: PinKind, name: string, branch: string | undefined): Pin | undefined {
  const b = branch ?? ""
  return pin && pin.kind === kind && pin.name === name && pin.branch === b ? undefined : { kind, name, branch: b }
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c)

/**
 * Does `name` appear in `branch` as a whole piece? Case-insensitive and bounded by
 * the start, the end or a non letter/digit: `feature/1187-loyalty-points` contains
 * `loyalty-points`, but `feat/caching` does not contain `cache`. Uses `indexOf`,
 * no regex.
 */
export function branchContains(branch: string, name: string): boolean {
  if (!name) return false
  const b = branch.toLowerCase()
  const n = name.toLowerCase()
  for (let i = b.indexOf(n); i >= 0; i = b.indexOf(n, i + 1)) {
    if (!isWordChar(b[i - 1]) && !isWordChar(b[i + n.length])) return true
  }
  return false
}

const sameWorkItem = (a: WorkItem | undefined, b: WorkItem) =>
  a !== undefined && a.id !== undefined && b.id !== undefined && a.system === b.system && a.id.toUpperCase() === b.id.toUpperCase()

/**
 * The branch's change and why it matches, or `undefined`. First by work item (the
 * branch's equals the `.openspec.yaml` one; the first in the list if several);
 * otherwise the longest name contained in the branch.
 */
export function matchBranch(candidates: readonly Candidate[], git: GitInfo): { index: number; match: BranchMatch } | undefined {
  const branch = git.branch
  if (!branch) return undefined
  const item = branchWorkItem(branch, git.remote, { anyNumber: true })
  if (item) {
    const i = candidates.findIndex((c) => sameWorkItem(c.workItem, item))
    if (i >= 0) return { index: i, match: { by: "workItem", length: candidates[i]!.name.length } }
  }
  let best = -1
  candidates.forEach((c, i) => {
    if (branchContains(branch, c.name) && (best < 0 || c.name.length > candidates[best]!.name.length)) best = i
  })
  return best < 0 ? undefined : { index: best, match: { by: "name", length: candidates[best]!.name.length } }
}

/** Index of the branch's change (see `matchBranch`), or -1. */
export function branchMatch(candidates: readonly Candidate[], git: GitInfo): number {
  return matchBranch(candidates, git)?.index ?? -1
}

/** `candidates` goes from newest to oldest; without candidates, index 0 and `recent`. */
export function chooseChange(candidates: readonly Candidate[], git: GitInfo, pin?: Pin): { index: number; reason: ChoiceReason } {
  const pinned = activePin(
    pin,
    "sdd",
    git.branch,
    candidates.map((c) => c.name),
  )
  if (pinned !== undefined) return { index: candidates.findIndex((c) => c.name === pinned), reason: "pinned" }
  const matched = branchMatch(candidates, git)
  if (matched >= 0) return { index: matched, reason: "branch" }
  return { index: 0, reason: "recent" }
}

/** Each change with the work item from its `.openspec.yaml` (ignoring the branch and the proposal). */
export async function readCandidates(root: string, names: readonly string[], fsx: Fsx = nodeFs, remote?: GitRemote): Promise<Candidate[]> {
  return Promise.all(
    names.map(async (name): Promise<Candidate> => {
      const file = join(root, "openspec", "changes", name, ".openspec.yaml")
      const text = (await isInside(root, file)) ? await fsx.readText(file, { maxBytes: MAX_GIT_BYTES }) : undefined
      const workItem = text !== undefined ? detectWorkItem({ yaml: parseOpenspecYaml(text), remote }) : undefined
      return workItem ? { name, workItem } : { name }
    }),
  )
}
