// Which methodology the sidebar focuses on: the pinned one, the branch's or the
// most recent. Kept apart from `focus.ts` so `flow-view.ts` can use it without
// importing the renderers (types only). No IO.
import type { BranchMatch } from "../model.ts"
import type { Focus, FocusReason, OddView, SddView } from "./flow-view.ts"

/** Matching by work item is more specific than by name; between names, the longest. */
function compareMatch(a: BranchMatch, b: BranchMatch): number {
  const by = (m: BranchMatch) => (m.by === "workItem" ? 1 : 0)
  return by(a) - by(b) || a.length - b.length
}

const isStamp = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0

/**
 * Which methodology to show and why. (1) The pinned one (if both sources carry a
 * pin while it changes, SDD wins until the next read). Without a pin and with both
 * an SDD change and an ODD feature: (2) the one matching the branch; if both match,
 * the more specific (`compareMatch`) and, on a tie, SDD; (3) otherwise the most
 * recently modified (tie: SDD). If either date is missing, `undefined`: everything
 * is shown instead of guessing. With a single methodology (or incoherent SDD)
 * there is no focus.
 */
export function chooseFocus(sdd: SddView, odd: OddView): { focus: Focus; reason: FocusReason } | undefined {
  if (sdd.kind === "change" && sdd.change.pinned) return { focus: "sdd", reason: "pinned" }
  if (odd.kind === "feature" && odd.feature.pinned) return { focus: "odd", reason: "pinned" }
  if (sdd.kind !== "change" || odd.kind !== "feature") return undefined
  const sb = sdd.change.branchMatch
  const ob = odd.feature.branchMatch
  if (sb || ob) return { focus: sb && (!ob || compareMatch(sb, ob) >= 0) ? "sdd" : "odd", reason: "branch" }
  const su = sdd.change.updatedAt
  const ou = odd.feature.updatedAt
  if (!isStamp(su) || !isStamp(ou)) return undefined
  return { focus: su >= ou ? "sdd" : "odd", reason: "recent" }
}
