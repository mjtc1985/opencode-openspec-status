// Full screen (`/openspec-status`): the same diagrams with more width and the
// details the sidebar cuts. With room for two 40-column columns, ODD and SDD sit
// side by side; otherwise stacked. On top, the ODD feature list to pin one. With a
// pin, like the sidebar: only that methodology plus «also: …»; the sidebar's
// automatic focus (branch or recent) does not apply here.
import { t } from "../i18n.ts"
import type { ColorKey, Line } from "../model.ts"
import type { FlowView } from "./flow-view.ts"
import { pinnedFocusOnly, visibleSections, withAlso } from "./focus.ts"
import { renderOdd } from "./odd.ts"
import { marked, PRODUCT } from "./parts.ts"
import { type OddListView, renderOddList } from "./odd-list.ts"
import { reviewBlock } from "./review.ts"
import { renderSdd } from "./sdd.ts"
import { joinSections, renderIdle, renderStale } from "./sidebar.ts"
import { lineWidth, padTo, seg, truncate } from "./text.ts"

const MIN_COLUMN = 40
const GAP = 3

function sideBySide(left: Line[], right: Line[], leftWidth: number): Line[] {
  const rows = Math.max(left.length, right.length)
  const lines: Line[] = []
  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? []
    const r = right[i] ?? []
    lines.push(r.length === 0 ? l : [...padTo(l, leftWidth + GAP), ...r])
  }
  return lines
}

/** When each mark changes: the same rules the view applies, in plain words. */
const legendItems = (): [mark: string, color: ColorKey, text: string][] => [
  ["✓", "success", t("legend.done")],
  ["◉", "accent", t("legend.writing")],
  ["·", "warning", t("legend.waiting")],
  ["⚠", "warning", t("legend.drift")],
  ["·", "muted", t("legend.refresh")],
]

export function legend(width: number): Line[] {
  const lines: Line[] = [[seg(` ${t("legend.title")}`, "muted", true)]]
  for (const [mark, color, text] of legendItems()) lines.push(...marked(mark, color, text, "muted", width))
  return lines
}

export type FullOptions = {
  /** ODD feature list from `odd/tasks/` with its selection; not drawn without it. */
  oddList?: OddListView
}

/** Without a pin it shows everything, even if the sidebar focuses on its own: pinning happens here. */
export function renderFull(flow: FlowView, width: number, fullOptions: FullOptions = {}): Line[] {
  const view = pinnedFocusOnly(flow)
  const options = { full: true }
  const title: Line = [seg(" ◆ ", "accent"), seg(PRODUCT, "text", true)]
  const root = truncate(view.root, width - lineWidth(title) - 3)
  const parts: Line[][] = [[root ? [...title, seg(" · ", "muted"), seg(root, "muted")] : title]]
  if (fullOptions.oddList) parts.push(renderOddList(fullOptions.oddList, width))

  const shown = visibleSections(view)
  const odd = (w: number) => withAlso(renderOdd(view, w, options), "odd", view, w, options)
  const sdd = (w: number) => withAlso(renderSdd(view, w, options), "sdd", view, w, options)
  if (shown.odd && shown.sdd && width >= 2 * MIN_COLUMN) {
    const leftWidth = Math.floor((width - GAP) / 2)
    const rightWidth = width - GAP - leftWidth
    parts.push(sideBySide(odd(leftWidth), sdd(rightWidth), leftWidth))
  } else {
    if (shown.odd) parts.push(odd(width))
    if (shown.sdd) parts.push(sdd(width))
  }
  if (view.idle) parts.push(renderIdle(view, width, options))
  if (!shown.odd) parts.push(reviewBlock(view, width, true))
  parts.push(renderStale(view, width, options))
  if (!view.idle) parts.push(legend(width))
  parts.push([[seg(` esc: ${t("help.back")}`, "muted")]])
  return joinSections(
    parts.filter((p) => p.length > 0),
    width,
  )
}
