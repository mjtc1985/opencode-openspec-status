// Sidebar (≤ 38 columns): ODD on top, then SDD, the review (inside ODD or in its
// own block), the empty state and, at the end, the stale sources. With a focus
// (the pin or, without one, the branch's or most recent methodology), only that
// methodology plus an «also: …» line with the other.
import { t } from "../i18n.ts"
import { SDD_PHASES, SIDEBAR_WIDTH, type Line } from "../model.ts"
import { formatAge, type FlowView } from "./flow-view.ts"
import { visibleSections, withAlso } from "./focus.ts"
import { renderOdd } from "./odd.ts"
import { marked, PRODUCT, type RenderOptions } from "./parts.ts"
import { reviewBlock } from "./review.ts"
import { renderSdd } from "./sdd.ts"
import { seg, truncateLine } from "./text.ts"

/** Empty state: everything muted, with the SDD chain and how to start. */
export function renderIdle(view: FlowView, width: number, options: RenderOptions): Line[] {
  const lines: Line[] = [[seg(` ◇ ${PRODUCT}`, "muted")], []]
  const chain = SDD_PHASES.join(" → ")
  if (options.full && chain.length + 3 <= width) {
    lines.push([seg("   " + chain, "muted")])
  } else {
    for (let i = 0; i < SDD_PHASES.length; i += 3) {
      const group = SDD_PHASES.slice(i, i + 3).join(" → ")
      lines.push([seg("   " + group + (i + 3 < SDD_PHASES.length ? " →" : ""), "muted")])
    }
  }
  lines.push([], [seg(` ${t("idle.nothing")}`, "muted")], ...marked(" ", "muted", t("idle.start"), "muted", width), ...marked(" ", "muted", t("idle.orOdd"), "muted", width))
  if (options.full && view.sdd.kind === "none" && view.sdd.hint) lines.push(...marked(" ", "muted", view.sdd.hint, "muted", width))
  return lines
}

/** One line per source whose last read failed. */
export function renderStale(view: FlowView, width: number, options: RenderOptions): Line[] {
  const lines: Line[] = []
  for (const s of view.stale) {
    lines.push(...marked("⚠", "warning", t("stale.source", { source: s.label, age: formatAge(s.ageMs) }), "warning", width))
    if (options.full && s.error) lines.push(...marked(" ", "muted", s.error, "muted", width))
  }
  return lines
}

/** Sections in order, unjoined; `renderSidebar` and `renderFull` join them. */
export function sections(view: FlowView, width: number, options: RenderOptions): Line[][] {
  const out: Line[][] = []
  const shown = visibleSections(view)
  if (shown.odd) out.push(withAlso(renderOdd(view, width, options), "odd", view, width, options))
  if (shown.sdd) out.push(withAlso(renderSdd(view, width, options), "sdd", view, width, options))
  if (view.idle) out.push(renderIdle(view, width, options))
  // Without the ODD section, the review goes in its own block.
  if (!shown.odd) out.push(reviewBlock(view, width, options.full))
  out.push(renderStale(view, width, options))
  return out.filter((s) => s.length > 0)
}

/** Joins sections with a blank line and makes sure nothing exceeds `width`. */
export function joinSections(parts: Line[][], width: number): Line[] {
  const lines: Line[] = []
  parts.forEach((part, i) => {
    if (i > 0) lines.push([])
    lines.push(...part)
  })
  return lines.map((line) => truncateLine(line, width))
}

export function renderSidebar(view: FlowView, width = SIDEBAR_WIDTH): Line[] {
  return joinSections(sections(view, width, { full: false }), width)
}
