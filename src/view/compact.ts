// Compact indicator next to the prompt: `SDD · spec ▸ design`, `ODD · T7/9 · rev ✗`,
// followed by the agent's clock (`· 1:24`) or `· waiting`…
import { t } from "../i18n.ts"
import type { Line } from "../model.ts"
import { type FlowView, workingClock } from "./flow-view.ts"
import { oddProgress, visibleSections } from "./focus.ts"
import { REVIEW_MARK } from "./review.ts"
import { seg } from "./text.ts"

const SEP = () => seg(" · ", "muted")

function oddPart(view: FlowView): Line {
  const odd = view.odd
  if (odd.kind !== "feature") return []
  return [seg("ODD", "text"), SEP(), seg(oddProgress(odd), "accent")]
}

function sddPart(view: FlowView): Line {
  const sdd = view.sdd
  switch (sdd.kind) {
    case "none":
      return []
    case "incoherent":
      return [seg("SDD ", "text"), seg("⚠", "warning"), seg(` ${t("compact.incoherent")}`, "warning")]
    case "unsupported":
      return [seg("SDD ", "text"), seg("⚠", "warning"), seg(` ${t("compact.unknownFormat")}`, "warning")]
    case "change": {
      const { change } = sdd
      if (change.blocked.length > 0 || change.phases[change.current] === "blocked") {
        return [seg("SDD ", "text"), seg("✗", "error"), seg(` ${t("compact.blocked")}`, "error")]
      }
      const line: Line = [seg("SDD", "text"), SEP()]
      if (change.current === "apply" && change.tasks.total > 0) {
        line.push(seg(`apply ${change.tasks.completed}/${change.tasks.total}`, "accent"))
      } else {
        line.push(seg(change.current, "accent"))
        if (change.next && change.next !== change.current) line.push(seg(" ▸ ", "muted"), seg(change.next, "text"))
      }
      return line
    }
  }
}

function reviewPart(view: FlowView): Line {
  if (!view.reviewMark) return []
  const [mark, color] = REVIEW_MARK[view.reviewMark]
  return [seg("rev ", "muted"), seg(mark, color)]
}

/**
 * One-line indicator; `undefined` when nothing is active. With a focus (pinned,
 * branch or most recent, like the sidebar), only that methodology (plus the review,
 * which belongs to the repository).
 */
export function compactLabel(view: FlowView): Line | undefined {
  if (view.idle) return undefined
  const shown = visibleSections(view)
  // The review goes next to ODD; without ODD, after SDD.
  const sdd = shown.sdd ? sddPart(view) : []
  const ordered = shown.odd ? [oddPart(view), reviewPart(view), sdd] : [sdd, reviewPart(view)]
  const parts = ordered.filter((p) => p.length > 0)
  const line: Line = []
  parts.forEach((part, i) => {
    if (i > 0) line.push(SEP())
    line.push(...part)
  })
  // The session: the clock while the agent works, «waiting» when it asks you.
  const clock = workingClock(view)
  if (view.activity?.state === "busy" && clock) line.push(SEP(), seg(clock, "accent"))
  if (view.activity?.state === "waiting") line.push(SEP(), seg(t("compact.waiting"), "warning"))
  if (view.stale.length > 0) line.push(seg(" ⚠", "warning"))
  return line
}
