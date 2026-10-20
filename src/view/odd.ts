// ODD diagram: the protocol (authorize → explore → tasks → implement → close) with
// the per-task cycle inside «implement». Everything coming from markdown or git is
// inferred, hence the «inferred» in the header.
import { t } from "../i18n.ts"
import type { ColorKey, Line, OddTaskStatus } from "../model.ts"
import { type CycleStep, type FlowView, type OddFeatureView, workingClock } from "./flow-view.ts"
import { autoLabel, autoReason } from "./focus.ts"
import { header, INDENT, labelled, marked, pinLabel, type RenderOptions } from "./parts.ts"
import { REVIEW_MARK, reviewBody } from "./review.ts"
import { displayWidth, lineText, lineWidth, padTo, seg, sliceToWidth, truncate, truncateLine } from "./text.ts"

const BIG_INNER = 30 // «implement» box, with the cycle inside
const SMALL_INNER = 22 // «close» box
const SIDEBAR_WARNINGS = 2

const TASK_MARK: Record<OddTaskStatus, [string, ColorKey]> = {
  done: ["✓", "success"],
  active: ["◉", "accent"],
  todo: ["○", "muted"],
}

const stem = (color: ColorKey = "muted"): Line => [seg(INDENT, "muted"), seg("▼", color)]
const node = (mark: string, color: ColorKey, text: Line): Line => [seg(INDENT, "muted"), seg(mark, color), seg(" ", "muted"), ...text]

function boxed(inner: Line, width: number): Line {
  return [seg(" │", "accent"), ...padTo(truncateLine(inner, width), width, " ", "muted"), seg("│", "accent")]
}

/** `odd/tasks/long-name.md` → `odd/tasks/long….md` so it fits in `max`. */
export function shortenPath(file: string, max: number): string {
  if (displayWidth(file) <= max) return file
  const slash = file.lastIndexOf("/")
  const dir = slash >= 0 ? file.slice(0, slash + 1) : ""
  const base = file.slice(slash + 1)
  const dot = base.lastIndexOf(".")
  const ext = dot > 0 ? base.slice(dot) : ""
  const stemRoom = max - displayWidth(dir) - displayWidth(ext) - 1
  if (stemRoom < 0) return truncate(file, max)
  return dir + sliceToWidth(base.slice(0, dot > 0 ? dot : base.length), stemRoom) + "…" + ext
}

function cycleRows(odd: OddFeatureView, view: FlowView): Line[] {
  const mark = view.reviewMark
  const hot = (step: CycleStep): ColorKey => (odd.step !== step ? "muted" : step === "review" && mark === "failed" ? "error" : "accent")
  const word = (text: string, step: CycleStep) => seg(text, hot(step), odd.step === step)
  const loop: ColorKey = mark === "failed" ? "error" : "muted"
  const reviewMark = mark ? seg(REVIEW_MARK[mark][0], REVIEW_MARK[mark][1]) : seg(" ", "muted")
  const [code, checks, commit, fix, review] = [t("odd.code"), t("odd.checks"), t("odd.commit"), t("odd.fix"), t("odd.review")]
  // Geometry follows the words, which change with the language: the down arrow
  // hangs from the third letter of «commit» and «review» sits centred under it.
  const pipe = 2 + displayWidth(code) + 4 + displayWidth(checks) + 4 + 2
  const reviewAt = Math.max(7, pipe - Math.floor(displayWidth(review) / 2) - 1)
  const fixRow: Line = [seg("    ", "muted"), seg(`│ ${fix}`, loop)]
  return [
    [seg("  ", "muted"), word(code, "code"), seg(" ─▶ ", "muted"), word(checks, "checks"), seg(" ─▶ ", "muted"), word(commit, "commit")],
    [seg("    ", "muted"), seg("▲", loop), seg(" ".repeat(Math.max(1, pipe - 5)), "muted"), seg("│", "muted")],
    [...padTo(fixRow, pipe), seg("▼", "muted")],
    [seg("    ", "muted"), seg("└" + "─".repeat(reviewAt - 6), loop), seg(" ", "muted"), word(review, "review"), seg(" ", "muted"), reviewMark],
  ]
}

function implementText(odd: OddFeatureView): string {
  if (odd.total === 0) return t("odd.noTasksShort")
  if (odd.feature.current) return t("sdd.nOfTotal", { n: odd.feature.current.id, total: odd.total })
  return t("odd.doneOf", { done: odd.done, total: odd.total })
}

/**
 * Row under «implement» (otherwise blank): «▸ working 1:24» while the agent works
 * with changes in progress, «waiting for you» when it asks you something.
 */
function activityRow(odd: OddFeatureView, view: FlowView): Line {
  if (view.activity?.state === "waiting") return [seg("   ", "muted"), seg(t("live.waiting"), "warning")]
  if (!odd.working) return []
  const clock = workingClock(view)
  return [seg("   ", "muted"), seg(`▸ ${t("live.working")}`, "accent"), ...(clock ? [seg(" " + clock, "text")] : [])]
}

function diagram(odd: OddFeatureView, view: FlowView, width: number): Line[] {
  const lines: Line[] = []
  lines.push(node("✓", "success", [seg(t("odd.authorize"), "text")]), stem())
  lines.push(node("✓", "success", [seg(t("odd.exploreClassify"), "text")]), stem())
  const count = ` (${odd.total})`
  const tasksLead = node("✓", "success", [seg(t("odd.tasks"), "text"), seg("  ", "muted")])
  const file = shortenPath(odd.feature.file, width - lineWidth(tasksLead) - count.length)
  lines.push([...tasksLead, seg(file, "muted"), seg(count, "muted")], stem())

  const done = odd.feature.allDone && odd.total > 0
  if (done) {
    lines.push(node("✓", "success", [seg(`${t("odd.implement")} · ${t("sdd.nOfTotal", { n: odd.total, total: odd.total })}`, "text")]), stem())
    lines.push([seg(" ┌" + "─".repeat(SMALL_INNER) + "┐", "accent")])
    lines.push([...boxed([seg(" ", "muted"), seg("◉", "accent"), seg(" ", "muted"), seg(t("odd.close"), "accent", true)], SMALL_INNER), seg(` ◀ ${t("sdd.youAreHere")}`, "accent", true)])
    lines.push([seg(" └" + "─".repeat(SMALL_INNER) + "┘", "accent")])
    return lines
  }

  lines.push([seg(" ┌" + "─".repeat(BIG_INNER) + "┐", "accent")])
  const title = [seg(" ", "muted"), seg("◉", "accent"), seg(" ", "muted"), seg(t("odd.implement"), "accent", true), seg(` · ${implementText(odd)}`, "text")]
  lines.push(boxed(title, BIG_INNER), boxed(activityRow(odd, view), BIG_INNER))
  for (const row of cycleRows(odd, view)) lines.push(boxed(row, BIG_INNER))
  lines.push([seg(" └─┬" + "─".repeat(BIG_INNER - 2) + "┘", "accent")])
  lines.push([seg(INDENT, "muted"), seg("▼", "accent"), seg(`  ◀ ${t("sdd.youAreHere")}`, "accent", true)])
  const pending = odd.pending === 0 ? "" : `  (${t(odd.pending === 1 ? "odd.pendingOne" : "odd.pendingMany", { n: odd.pending })})`
  lines.push(node("○", "muted", [seg(t("odd.close"), "muted"), seg(pending, "muted")]))
  return lines
}

const inferred = () => t("common.inferred")

/** Name on the left and the tag against the right margin. */
function taggedHeader(name: string, tag: string, width: number): Line {
  const head = header("ODD", name, width - tag.length - 2)
  return [...padTo(head, width - tag.length), seg(tag, "muted")]
}

/**
 * Header with «inferred» on the right. Pinned (or focused without a pin, by branch
 * or as the most recent): «pinned · inferred» («new · inferred», «branch ·
 * inferred»…) when the whole name still fits; otherwise the reason moves to its own line.
 */
function oddHeader(odd: OddFeatureView, width: number, auto?: "branch" | "recent"): Line[] {
  const why = odd.feature.pinned ? pinLabel(odd.feature.pinnedNew) : auto ? autoLabel(auto) : undefined
  if (!why) return [taggedHeader(odd.name, inferred(), width)]
  const whole = taggedHeader(odd.name, `${why} · ${inferred()}`, width)
  if (lineText(whole).includes(odd.name)) return [whole]
  return [taggedHeader(odd.name, inferred(), width), [seg(INDENT, "muted"), seg(`(${why})`, "muted")]]
}

/** Whole ODD section; empty without a feature. */
export function renderOdd(view: FlowView, width: number, options: RenderOptions): Line[] {
  const odd = view.odd
  if (odd.kind !== "feature") return []
  const lines: Line[] = [...oddHeader(odd, width, autoReason(view, "odd")), []]
  lines.push(...diagram(odd, view, width))

  const maxLines = options.full ? undefined : 2
  const footer: Line[] = []
  const current = odd.feature.current
  if (current) footer.push(...labelled(t("label.now"), `${current.id} ${current.title}`, width, { maxLines }))
  footer.push(...reviewBody(view, width, { label: t("odd.review"), full: options.full }))
  if (odd.feature.nextStep) footer.push(...labelled(t("label.then"), odd.feature.nextStep, width, { maxLines, labelColor: "muted" }))
  const warnings = options.full ? odd.feature.warnings : odd.feature.warnings.slice(0, SIDEBAR_WARNINGS)
  for (const warning of warnings) footer.push(...marked("⚠", "muted", warning, "muted", width, maxLines))
  if (odd.feature.warnings.length > warnings.length) footer.push([seg(`   ${t("common.andMore", { n: odd.feature.warnings.length - warnings.length })}`, "muted")])
  if (footer.length > 0) lines.push([], ...footer)

  if (options.full) {
    lines.push([], ...marked(" ", "muted", t("odd.file", { file: odd.feature.file }), "muted", width))
    for (const task of odd.feature.tasks) {
      const [mark, color] = TASK_MARK[task.status] ?? ["○", "muted"]
      const text = task.status === "todo" ? "muted" : "text"
      lines.push(truncateLine([seg(INDENT, "muted"), seg(mark, color), seg(` ${task.id} `, "text", task.status === "active"), seg(task.title, text)], width))
    }
  }
  return lines
}
