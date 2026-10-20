// Review block: state, lens grid and what to do. Never shows commands: the
// plugin is read-only.
import { t } from "../i18n.ts"
import type { ColorKey, LensStatus, Line } from "../model.ts"
import type { FlowView, ReviewMark } from "./flow-view.ts"
import { labelled, marked } from "./parts.ts"
import { lineWidth, padTo, seg, truncateLine } from "./text.ts"

export const REVIEW_MARK: Record<ReviewMark, [string, ColorKey]> = {
  ok: ["✓", "success"],
  running: ["◉", "accent"],
  failed: ["✗", "error"],
}

const LENS_MARK: Record<LensStatus["status"], [string, ColorKey]> = {
  ok: ["✓", "success"],
  running: ["◉", "accent"],
  findings: ["✗", "error"],
}

const lensName = (lens: string) => lens.replace(/^review-/, "")

function lensItem(lens: LensStatus): Line {
  const [mark, color] = LENS_MARK[lens.status] ?? ["○", "muted"]
  const count = lens.status === "findings" && lens.findings !== undefined ? ` ${lens.findings}` : ""
  return [seg(mark, color), seg(` ${lensName(lens.lens)}${count}`, "text")]
}

/** Two lenses per line, in columns; one per line if they do not fit. */
export function lensGrid(lenses: LensStatus[], width: number, indent = 3): Line[] {
  const items = lenses.map(lensItem)
  const lead = seg(" ".repeat(indent), "muted")
  const left = Math.max(0, ...items.filter((_, i) => i % 2 === 0).map(lineWidth))
  const right = Math.max(0, ...items.filter((_, i) => i % 2 === 1).map(lineWidth))
  if (indent + left + 2 + right > width) return items.map((item) => truncateLine([lead, ...item], width))
  const lines: Line[] = []
  for (let i = 0; i < items.length; i += 2) {
    const second = items[i + 1]
    lines.push(second ? [lead, ...padTo(items[i]!, left + 2), ...second] : [lead, ...items[i]!])
  }
  return lines
}

function lensDetail(lens: LensStatus): string {
  if (lens.status === "running") return t("review.lensRunning")
  if (lens.status === "ok") return t("review.lensClean")
  if (lens.findings === undefined) return t("review.lensFindings")
  return lens.findings === 1 ? t("review.oneFinding") : t("review.manyFindings", { n: lens.findings })
}

function stateColor(mark: ReviewMark | undefined): ColorKey {
  return mark ? REVIEW_MARK[mark][1] : "text"
}

/**
 * Review body (without a header). `label` is «review» inside ODD and «state» in
 * the standalone block.
 */
export function reviewBody(view: FlowView, width: number, options: { label: string; full: boolean }): Line[] {
  const review = view.review
  const maxLines = options.full ? undefined : 2
  switch (review.kind) {
    case "none":
      return []
    case "unavailable":
      return marked(" ", "muted", `${t("odd.review")}: ${review.reason}`, "muted", width)
    case "incoherent": {
      const lines: Line[] = [[seg(" ", "muted"), seg(`⚠ ${t("review.incoherentTitle")}`, "warning", true)]]
      const reasons = options.full ? review.reasons : review.reasons.slice(0, 2)
      for (const reason of reasons) lines.push(...marked("·", "warning", reason, "warning", width, maxLines))
      if (review.reasons.length > reasons.length) lines.push([seg(`   ${t("common.andMore", { n: review.reasons.length - reasons.length })}`, "muted")])
      return lines
    }
    case "review": {
      const lines = labelled(options.label, review.state, width, { color: stateColor(view.reviewMark), labelColor: "accent" })
      if (options.full) {
        const facts = [review.riskLevel ? t("review.risk", { level: review.riskLevel }) : "", t("review.entry", { status: review.entryStatus }), t("review.lineage", { id: review.lineageId })].filter(Boolean)
        lines.push(...marked(" ", "muted", facts.join(" · "), "muted", width))
      }
      if (review.lenses && review.lenses.length > 0) {
        if (options.full) {
          for (const lens of review.lenses) {
            const [mark, color] = LENS_MARK[lens.status] ?? ["○", "muted"]
            lines.push(truncateLine([seg("   ", "muted"), seg(mark, color), seg(` ${lensName(lens.lens)}`, "text"), seg(` · ${lensDetail(lens)}`, "muted")], width))
          }
        } else {
          lines.push(...lensGrid(review.lenses, width))
        }
      }
      if (review.applies === "current" && review.stop) {
        lines.push(...labelled(t("review.stopped"), review.stop.description ?? review.stop.reasonCode, width, { color: "warning", labelColor: "warning", maxLines }))
        lines.push([seg(`   → ${t("review.manualAction")}`, "muted")])
      }
      if (review.applies === "other") lines.push(...marked(" ", "muted", t("review.otherState"), "muted", width))
      if (review.state === "correction_required" && review.applies !== "current") {
        lines.push(...marked("▸", "error", t("review.fixAndRetry"), "text", width))
      }
      return lines
    }
  }
}

/** Standalone review block (when there is no ODD): «── review ──…» header and body. */
export function reviewBlock(view: FlowView, width: number, full: boolean): Line[] {
  const review = view.review
  if (review.kind === "none") return []
  if (review.kind === "unavailable") return reviewBody(view, width, { label: t("review.state"), full })
  const title: Line = [seg(` ── ${t("odd.review")} `, "muted")]
  return [padTo(title, width, "─", "muted"), ...reviewBody(view, width, { label: t("review.state"), full })]
}
