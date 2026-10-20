// ODD feature list in the `/openspec-status` overview: one row per `odd/tasks/`
// document (pending ones first), with its progress and the `pinned` mark (or `new`
// when the plugin pinned it as it was started). ↑↓ move the selection (when there
// is more than one) and enter pins or releases the selected one. No IO.
import { t } from "../i18n.ts"
import type { Line } from "../model.ts"
import type { OddDocSummary } from "../sources/odd.ts"
import { padTo, clamp, displayWidth, lineWidth, truncate, truncateLine, seg } from "./text.ts"
import { pinLabel } from "./parts.ts"

export type OddListView = {
  features: readonly OddDocSummary[]
  selected: number
  /** Name of the pinned feature (already checked against the branch and the list). */
  pinned?: string
  /** The plugin pinned it as it was started in the session: `new` instead of `pinned`. */
  pinnedNew?: boolean
}

/** ↑ / ↓ on the list: stops at the ends. */
export function reduceOddList(selected: number, key: "up" | "down", count: number): number {
  if (count <= 0) return 0
  return clamp(clamp(selected, 0, count - 1) + (key === "up" ? -1 : 1), 0, count - 1)
}

/** Index of the selected name in the new list (the selection follows it on reload); if gone, the same index clamped. */
export function followOddSelection(selected: number, before: readonly OddDocSummary[], after: readonly OddDocSummary[]): number {
  const name = before[selected]?.name
  const at = name === undefined ? -1 : after.findIndex((f) => f.name === name)
  return at >= 0 ? at : clamp(selected, 0, Math.max(0, after.length - 1))
}

/** `T3/5` with a task in progress, `✓ 5/5` when all is done, `0/0` without tasks. */
function progress(f: OddDocSummary): Line {
  if (f.allDone) return [seg(`✓ ${f.done}/${f.total}`, "success")]
  if (f.current) return [seg(`${f.current}/${f.total}`, "accent")]
  return [seg(`${f.done}/${f.total}`, "muted")]
}

/** Header and one row per feature; empty when there are none. */
export function renderOddList(list: OddListView, width: number): Line[] {
  const n = list.features.length
  if (n === 0) return []
  const selected = clamp(list.selected, 0, n - 1)
  const lines: Line[] = [[seg(" ", "muted"), seg(t("oddList.title"), "text", true), seg(`  ${n}`, "muted")]]
  const nameWidth = Math.min(Math.max(...list.features.map((f) => displayWidth(f.name))), Math.max(12, Math.floor(width * 0.45)))
  const summaries = list.features.map(progress)
  const summaryWidth = Math.max(...summaries.map(lineWidth))
  list.features.forEach((f, i) => {
    const sel = i === selected
    let line: Line = [seg(" ", "muted"), sel ? seg("▸ ", "accent", true) : seg("  ", "muted"), seg(truncate(f.name, nameWidth), sel ? "accent" : "text", sel)]
    const summary = sel ? summaries[i]!.map((s) => ({ ...s, bold: true })) : summaries[i]!
    line = [...padTo(line, 3 + nameWidth + 2, " ", "muted"), ...summary]
    if (f.name === list.pinned) line = [...padTo(line, 3 + nameWidth + 2 + summaryWidth + 2, " ", "muted"), seg(pinLabel(list.pinnedNew), "accent", sel)]
    lines.push(truncateLine(line, width))
  })
  return lines
}
