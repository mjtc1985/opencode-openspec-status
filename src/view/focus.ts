// Focus: the sidebar shows a single methodology; the other is left as a muted line
// («also: …»). The branch's pin wins; without a pin and with both (an SDD change
// and an ODD feature), the branch's and otherwise the most recent. When it cannot
// be decided without guessing, everything is shown (the choice lives in
// `choose-focus.ts`). The full screen only focuses on a pin. No IO.
import { t } from "../i18n.ts"
import type { Line } from "../model.ts"
import type { FlowView, Focus, OddFeatureView } from "./flow-view.ts"
import { marked, type RenderOptions } from "./parts.ts"
import { phaseSummary } from "./sdd-detail.ts"
import { lineText } from "./text.ts"

/** `T7/9`, `3/9` without a task in progress, or `close` when all is done (as in the indicator). */
export function oddProgress(odd: OddFeatureView): string {
  if (odd.feature.allDone && odd.total > 0) return t("odd.close")
  if (odd.feature.current) return `${odd.feature.current.id}/${odd.total}`
  return `${odd.done}/${odd.total}`
}

/** Reason for `kind`'s automatic focus (`branch`/`recent` in its header); nothing if pinned or not the focused one. */
export function autoReason(view: FlowView, kind: Focus): "branch" | "recent" | undefined {
  if (view.focus !== kind || view.focusReason === undefined || view.focusReason === "pinned") return undefined
  return view.focusReason
}

/** Label of the automatic reason in the headers. */
export const autoLabel = (reason: "branch" | "recent"): string => t(reason === "branch" ? "focus.branch" : "focus.recent")

/** The view without automatic focus (the full screen shows everything except for a pin). */
export function pinnedFocusOnly(view: FlowView): FlowView {
  if (view.focusReason === undefined || view.focusReason === "pinned") return view
  const { focus: _focus, focusReason: _reason, ...rest } = view
  return rest
}

/** Which sections are drawn: the focused one yes, the other no; without focus, whatever exists. */
export function visibleSections(view: FlowView): { odd: boolean; sdd: boolean } {
  return {
    odd: view.odd.kind === "feature" && view.focus !== "sdd",
    sdd: view.sdd.kind !== "none" && view.focus !== "odd",
  }
}

/** «also: …» with what the focus leaves out; `undefined` if there is nothing or no focus. */
export function alsoText(view: FlowView): string | undefined {
  if (view.focus === "sdd") {
    if (view.odd.kind !== "feature") return undefined
    return t("focus.alsoOdd", { name: view.odd.name, progress: oddProgress(view.odd) })
  }
  if (view.focus === "odd") {
    const sdd = view.sdd
    switch (sdd.kind) {
      case "none":
        return undefined
      case "incoherent":
        return t("focus.alsoSddIncoherent")
      case "unsupported":
        return t("focus.alsoSddUnknown")
      case "change": {
        const { change } = sdd
        const several = change.choice && change.choice.total > 1 ? ` · ${t("focus.changes", { n: change.choice.total })}` : ""
        return t("focus.alsoSdd", { name: change.name, summary: lineText(phaseSummary(change)) }) + several
      }
    }
  }
  return undefined
}

/** `section` with the «also» line at the end if it is the focused section. */
export function withAlso(section: Line[], kind: Focus, view: FlowView, width: number, options: RenderOptions): Line[] {
  const text = view.focus === kind ? alsoText(view) : undefined
  if (!text || section.length === 0) return section
  return [...section, [], ...marked(" ", "muted", text, "muted", width, options.full ? undefined : 2)]
}
