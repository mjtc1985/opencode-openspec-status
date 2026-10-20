// Full-screen SDD detail (`/openspec-status`): list of active changes (↑↓, the
// selected row highlighted; enter pins it for the sidebar), strip of the 8 phases
// with the selected one in brackets (←→), the panel of that phase with what its
// artifacts say (PgUp/PgDn scroll it) and, on the last line, the key bar. There is
// no remote state: the work item is shown with its reference and, in propose, its
// URL. No IO.
import { t } from "../i18n.ts"
import { SDD_PHASES, type ColorKey, type DownstreamArtifact, type Line, type SddChange, type SddPhaseId, type StaleWarning, type UpstreamArtifact } from "../model.ts"
import type { SddDetail } from "../sources/sdd-detail.ts"
import { clampDetailState, type DetailState, type PanelScroll } from "./detail-state.ts"
import { DOWNSTREAM_PHASE, UPSTREAM_PHASE } from "./flow-view.ts"
import { clock, helpBar, type HelpItem, pinLabel, PRODUCT } from "./parts.ts"
import { MARK } from "./sdd.ts"
import { padTo, clamp, displayWidth, lineWidth, truncate, truncateLine, seg, wrap, wrapWithPrefix } from "./text.ts"

export type DetailModel = {
  changes: { status: SddChange; detail?: SddDetail }[]
  loading?: boolean
  error?: string
  /** Current branch (from `.git/HEAD`), to validate the pin. */
  branch?: string
  /** Change pinned for the sidebar (already checked against the branch and the list). */
  pinned?: string
  /** The plugin pinned it as it was started in the session: `new` instead of `pinned`. */
  pinnedNew?: boolean
  /**
   * The change the session works on (the sidebar's): its row carries «◉ writing
   * spec 1:24» or «waiting for you», and the phase being written gets ◉ in the strip.
   */
  live?: { name: string; writing?: SddPhaseId; text: string; tone: "accent" | "warning" }
}

/**
 * `height`: when given, the screen takes exactly that height: the panel is cut
 * (with «… N more above» / «… N more») and the key bar goes on the last line.
 * `canPin`: false on the home screen (no session to pin for).
 */
export type DetailRenderOptions = { height?: number; canPin?: boolean }

/** Keys of the SDD detail, in help-bar order. */
export const detailHelp = (): readonly HelpItem[] => [
  ["↑↓", t("help.change")],
  ["←→", t("help.phase")],
  [t("help.pageKeys"), t("help.scroll")],
  ["enter", t("help.pin")],
  ["tab", t("help.overview")],
  ["esc", t("help.back")],
]

const LIST_MAX = 6
const WHY_LINES = 4
const CHANGES_MAX = 5
const STALE_MAX = 3
const SUMMARY_MAX = 8
const S1 = "   " // section indent
const S2 = "     " // item indent

const UP_LABEL: Record<UpstreamArtifact, string> = { proposal: "proposal", specs: "specs", design: "design" }
const DOWN_LABEL: Record<DownstreamArtifact, string> = { tasks: "tasks", applyProgress: "apply-progress", verifyReport: "verify-report" }

type Artifact = "proposal" | "specs" | "design" | "tasks" | "applyProgress" | "verifyReport"
const ARTIFACT_FILE: Record<Artifact, string> = {
  proposal: "proposal.md",
  specs: "specs/<capability>/spec.md",
  design: "design.md",
  tasks: "tasks.md",
  applyProgress: "apply-progress.md",
  verifyReport: "verify-report.md",
}
const ARTIFACT_LABEL: Record<Artifact, string> = { ...UP_LABEL, ...DOWN_LABEL }

const DELTA: Record<string, [string, ColorKey]> = {
  added: ["+", "success"],
  modified: ["~", "warning"],
  removed: ["-", "error"],
  renamed: ["»", "accent"],
  unknown: ["·", "muted"],
}

const verdict = (v: string): [string, string, ColorKey] =>
  v === "pass" ? ["✓", t("verify.pass"), "success"] : v === "fail" ? ["✗", t("verify.fail"), "error"] : ["?", t("verify.unknown"), "warning"]

// ── Pieces ──────────────────────────────────────────────────────────────────

const text = (value: string, color: ColorKey = "text", bold = false): Line => [seg(value, color, bold)]
const rule = (width: number): Line => [seg(" " + "─".repeat(Math.max(0, width - 2)), "muted")]
const more = (n: number, above = false): Line => [seg(`${S1}${t(above ? "common.moreAbove" : "common.more", { n })}`, "muted")]

/** `left` and `right` on one line, `right` against the right margin; `undefined` if they do not fit. */
function split(left: Line, right: Line, width: number): Line | undefined {
  const rw = lineWidth(right)
  if (right.length === 0) return left
  if (lineWidth(left) + 2 + rw > width - 1) return undefined
  return [...padTo(left, width - 1 - rw, " ", "muted"), ...right]
}

/** `line` right-aligned; if it does not fit, indented on the left. */
function alignRight(line: Line, width: number, indent = "  "): Line {
  return split([], line, width) ?? [seg(indent, "muted"), ...line]
}

/** Wrapped text with a fixed indent on every line. */
function para(value: string, indent: string, color: ColorKey, width: number, maxLines?: number): Line[] {
  return wrapWithPrefix([seg(indent, "muted")], value, color, width, { indent: indent.length, ...(maxLines ? { maxLines } : {}) })
}

/** « <mark> text» cut to one line. */
function item(mark: string, markColor: ColorKey, value: string, width: number, color: ColorKey = "text", indent = S2): Line {
  const prefix: Line = [seg(indent, "muted"), seg(mark, markColor), seg(" ", "muted")]
  return [...prefix, seg(truncate(value, width - lineWidth(prefix)), color)]
}

const section = (title: string): Line => [seg(S1, "muted"), seg(title, "text", true)]

function missing(artifact: Artifact, detail: SddDetail | undefined, width: number): Line[] {
  const file = detail?.changeDir ? `${detail.changeDir}/${ARTIFACT_FILE[artifact]}` : ARTIFACT_FILE[artifact]
  return para(t("detail.missingArtifact", { artifact: ARTIFACT_LABEL[artifact], file }), S1, "muted", width)
}

const fileName = (detail: SddDetail, artifact: Artifact) => {
  const path = detail.files[artifact]?.[0]?.path
  return path ? (path.split("/").pop() ?? path) : ARTIFACT_FILE[artifact]
}

// ── Header and change list ──────────────────────────────────────────────────

const title = (): Line => [seg(" ", "muted"), seg(PRODUCT, "text", true), seg(" · ", "muted"), seg("SDD", "accent", true)]

/** One-line summary: `apply 6/16`, `spec ▸ design`, `✗ blocked`. */
export function phaseSummary(change: SddChange): Line {
  const stale: Line = Array.isArray(change.stale) && change.stale.length > 0 ? [seg(" ⚠", "warning")] : []
  if (change.blocked.length > 0 || change.phases[change.current] === "blocked") return [seg(`✗ ${t("compact.blocked")}`, "error"), ...stale]
  if (change.current === "apply" && change.tasks.total > 0) return [seg(`apply ${change.tasks.completed}/${change.tasks.total}`, "accent"), ...stale]
  const line: Line = [seg(change.current, "accent")]
  if (change.next && change.next !== change.current) line.push(seg(" ▸ ", "muted"), seg(change.next, "text"))
  return [...line, ...stale]
}

function changeList(model: DetailModel, selected: number, width: number): Line[] {
  const n = model.changes.length
  const start = n <= LIST_MAX ? 0 : Math.max(0, Math.min(selected - Math.floor(LIST_MAX / 2), n - LIST_MAX))
  const shown = model.changes.slice(start, start + LIST_MAX)
  const nameWidth = Math.min(Math.max(...shown.map((c) => displayWidth(c.status.name))), Math.max(12, Math.floor(width * 0.35)))
  const summaries = shown.map((c) => phaseSummary(c.status))
  const summaryWidth = Math.max(...summaries.map(lineWidth))
  // «pinned» («new») goes before the work item so it is not lost when the row is cut.
  const mark = pinLabel(model.pinnedNew)
  const pinWidth = shown.some((c) => c.status.name === model.pinned) ? mark.length + 2 : 0
  const lines = shown.map((c, i) => {
    const sel = start + i === selected
    let line: Line = [seg(" ", "muted"), sel ? seg("▸ ", "accent", true) : seg("  ", "muted"), seg(truncate(c.status.name, nameWidth), sel ? "accent" : "text", sel)]
    // The selected row is bold as a whole: the summary and the work item too.
    const summary = sel ? summaries[i]!.map((s) => ({ ...s, bold: true })) : summaries[i]!
    const col = 3 + nameWidth + 2 + summaryWidth
    line = [...padTo(line, 3 + nameWidth + 2, " ", "muted"), ...summary]
    if (c.status.name === model.pinned) line = [...padTo(line, col + 2, " ", "muted"), seg(mark, "accent", sel)]
    const ref = c.detail?.workItem?.ref
    if (ref) line = [...padTo(line, col + pinWidth + 3, " ", "muted"), seg(ref, sel ? "text" : "muted", sel)]
    if (model.live?.name === c.status.name) line = [...line, seg("  ", "muted"), seg(model.live.text, model.live.tone, sel)]
    return truncateLine(line, width)
  })
  if (n > LIST_MAX) lines.push([seg(`   ${t("sdd.nOfTotal", { n: selected + 1, total: n })}`, "muted")])
  return lines
}

// ── Phase strip ─────────────────────────────────────────────────────────────

function phaseItem(change: SddChange, phase: SddPhaseId, selected: boolean, writing?: SddPhaseId): Line {
  const status = change.phases[phase]
  const [mark, color] = phase === writing || (phase === change.current && status !== "blocked") ? ["◉", "accent" as ColorKey] : MARK[status]
  if (selected) return [seg(`[${mark} ${phase}]`, "accent", true)]
  return [seg(mark, color), seg(" " + phase, status === "todo" ? "muted" : "text")]
}

function stripRow(change: SddChange, phases: readonly SddPhaseId[], selected: SddPhaseId, last: boolean, writing?: SddPhaseId): Line {
  const line: Line = [seg("  ", "muted")]
  phases.forEach((phase, i) => {
    const sel = phase === selected
    if (i > 0) line.push(seg(phases[i - 1] === selected ? "─ " : sel ? " ─" : " ─ ", "muted"))
    line.push(...phaseItem(change, phase, sel, writing))
  })
  if (!last) line.push(seg(phases[phases.length - 1] === selected ? "─" : " ─", "muted"))
  return line
}

/** The 8 phases joined by « ─ »; if they do not fit, in equal rows (4 + 4, 3 + 3 + 2…). */
function phaseStrip(change: SddChange, selected: SddPhaseId, width: number, writing?: SddPhaseId): Line[] {
  let rows: Line[] = []
  for (let k = 1; k <= SDD_PHASES.length; k++) {
    const per = Math.ceil(SDD_PHASES.length / k)
    rows = []
    for (let i = 0; i < SDD_PHASES.length; i += per) rows.push(stripRow(change, SDD_PHASES.slice(i, i + per), selected, i + per >= SDD_PHASES.length, writing))
    if (rows.every((r) => lineWidth(r) <= width)) return rows
  }
  return rows.map((l) => truncateLine(l, width))
}

// ── Warnings ────────────────────────────────────────────────────────────────

/** Drift that concerns the phase: the later one (tasks/apply/verify) or the earlier one (propose/spec/design). */
export function staleFor(change: SddChange, phase: SddPhaseId): StaleWarning[] {
  if (change.stale === "unavailable") return []
  return change.stale
    .filter((w) => UPSTREAM_PHASE[w.upstream] === phase || DOWNSTREAM_PHASE[w.downstream] === phase || (phase === "apply" && w.downstream === "tasks"))
    .sort((a, b) => b.upstreamMtime - a.upstreamMtime)
}

const staleText = (w: StaleWarning) => `⚠ ${t(w.upstream === "specs" ? "stale.changedMany" : "stale.changedOne", { what: UP_LABEL[w.upstream], after: DOWN_LABEL[w.downstream] })}`
const staleTimes = (w: StaleWarning) => `${UP_LABEL[w.upstream]} ${clock(w.upstreamMtime)} · ${DOWN_LABEL[w.downstream]} ${clock(w.downstreamMtime)}`

function panelHeader(change: SddChange, phase: SddPhaseId, subtitle: string, width: number): Line[] {
  const left: Line = [seg("  ", "muted"), seg(phase, "accent", true), ...(subtitle ? [seg(" · ", "muted"), seg(subtitle, "text")] : [])]
  const warnings = staleFor(change, phase)
  const shown = warnings.slice(0, STALE_MAX)
  const lines: Line[] = []
  shown.forEach((w, i) => {
    const message: Line = [seg(staleText(w), "warning")]
    const joined = i === 0 ? split(left, message, width) : undefined
    if (i === 0) lines.push(joined ?? left)
    if (!joined) lines.push(alignRight(message, width))
    lines.push(alignRight([seg(staleTimes(w), "warning")], width, "    "))
  })
  if (shown.length === 0) lines.push(left)
  if (warnings.length > shown.length) lines.push(alignRight([seg(t("detail.moreWarnings", { n: warnings.length - shown.length }), "warning")], width))
  if (phase === "apply") {
    for (const reason of change.blocked) lines.push(...wrapWithPrefix([seg("  ", "muted"), seg("✗", "error"), seg(" ", "muted")], reason, "error", width, { indent: 4 }))
  }
  return lines
}

// ── Panels ──────────────────────────────────────────────────────────────────

type Panel = { subtitle: string; body: Line[]; focus?: number }

function explorePanel(change: SddChange, detail: SddDetail | undefined, width: number): Panel {
  const body = para(t("detail.exploreNote"), S1, "muted", width)
  const have = detail
    ? (Object.keys(ARTIFACT_FILE) as Artifact[]).filter((k) => (detail.files[k]?.length ?? 0) > 0).map((k) => ARTIFACT_LABEL[k])
    : SDD_PHASES.filter((p) => p !== "explore" && change.phases[p] === "done")
  body.push(...para(have.length > 0 ? t("detail.alreadyHave", { list: have.join(", ") }) : t("detail.noArtifactsYet"), S1, "text", width))
  return { subtitle: t("detail.noArtifact"), body }
}

function workItemLines(detail: SddDetail, width: number): Line[] {
  const wi = detail.workItem
  if (!wi) return para(t("detail.noWorkItem"), S2, "muted", width)
  const from = { "openspec-yaml": ".openspec.yaml", branch: t("detail.fromBranch"), proposal: t("detail.fromProposal") }[wi.source]
  const lines: Line[] = [truncateLine([seg(S2, "muted"), seg(wi.ref, "accent", true), seg(` · ${t("detail.from", { source: from })}`, "muted")], width)]
  if (wi.url && wi.url !== wi.ref) lines.push(...wrap(wi.url, Math.max(1, width - S2.length)).map((l) => [seg(S2, "muted"), seg(l, "text")]))
  else if (!wi.url && wi.system === "azure-devops") lines.push(...para(t("detail.noUrl"), S2, "muted", width))
  return lines
}

function proposePanel(detail: SddDetail | undefined, width: number): Panel {
  const p = detail?.proposal
  if (!detail || !p) return { subtitle: "proposal.md", body: missing("proposal", detail, width) }
  const body: Line[] = []
  if (p.why) body.push(section(t("detail.why")), ...para(p.why, S2, "text", width, WHY_LINES))
  if (p.changes.length > 0) {
    body.push(section(t("detail.whatChanges")))
    for (const c of p.changes.slice(0, CHANGES_MAX)) body.push(item("·", "muted", c, width))
    if (p.changes.length > CHANGES_MAX) body.push([seg(`${S2}${t("common.andMore", { n: p.changes.length - CHANGES_MAX })}`, "muted")])
  }
  if (p.capabilities.length > 0) {
    body.push(section(t("detail.capabilities")))
    for (const c of p.capabilities) {
      const [mark, color] = c.kind === "new" ? DELTA.added! : DELTA.modified!
      body.push(truncateLine([seg(S2, "muted"), seg(mark, color), seg(" " + c.name, "text"), seg(`  ${t(c.kind === "new" ? "detail.capNew" : "detail.capModified")}`, "muted")], width))
    }
  }
  if (body.length === 0) body.push(...para(t("detail.proposalUnknown"), S1, "muted", width))
  body.push(section("Work item"), ...workItemLines(detail, width))
  return { subtitle: fileName(detail, "proposal"), body }
}

function specPanel(detail: SddDetail | undefined, width: number): Panel {
  if (!detail || detail.specs.length === 0) return { subtitle: "specs", body: missing("specs", detail, width) }
  const reqs = detail.specs.reduce((n, s) => n + s.requirements.length, 0)
  const caps = detail.specs.length
  const body: Line[] = []
  for (const spec of detail.specs) {
    const n = spec.requirements.length
    body.push(truncateLine([seg(S1, "muted"), seg(spec.capability, "text", true), seg(`  ${t(n === 1 ? "detail.reqOne" : "detail.reqMany", { n })}`, "muted")], width))
    if (n === 0) body.push(...para(t("detail.noRequirements", { file: spec.file }), S2, "muted", width))
    for (const r of spec.requirements) {
      const [mark, color] = DELTA[r.delta] ?? DELTA.unknown!
      const count = r.scenarios === 0 && (r.delta === "removed" || r.delta === "renamed") ? "" : t("detail.scenarios", { n: r.scenarios })
      const prefix: Line = [seg(S2, "muted"), seg(mark, color), seg(" ", "muted")]
      const room = width - 1 - lineWidth(prefix) - (count ? count.length + 2 : 0)
      const left: Line = [...prefix, seg(truncate(r.title, Math.max(1, room)), r.delta === "removed" ? "muted" : "text")]
      body.push(truncateLine(count ? (split(left, [seg(count, "muted")], width) ?? left) : left, width))
    }
  }
  return { subtitle: `${t(caps === 1 ? "detail.capOne" : "detail.capMany", { n: caps })} · ${t(reqs === 1 ? "detail.reqOne" : "detail.reqMany", { n: reqs })}`, body }
}

function designPanel(detail: SddDetail | undefined, width: number): Panel {
  const d = detail?.design
  if (!detail || !d) return { subtitle: "design.md", body: missing("design", detail, width) }
  const body: Line[] = [section(t("detail.decisions"))]
  if (d.decisions.length === 0) body.push([seg(`${S2}(${t("detail.noneRecognized")})`, "muted")])
  d.decisions.forEach((decision, i) => body.push(item(`${i + 1}.`, "muted", decision, width)))
  body.push(section(t("detail.risks")))
  if (d.risks.length === 0) body.push([seg(`${S2}(${t("detail.noneRecognized")})`, "muted")])
  for (const r of d.risks) body.push(item("·", "warning", r, width))
  return { subtitle: fileName(detail, "design"), body }
}

function tasksPanel(change: SddChange, detail: SddDetail | undefined, phase: "tasks" | "apply", width: number): Panel {
  const tasks = detail?.tasks
  const items = tasks ? tasks.groups.flatMap((g) => g.items) : []
  const total = change.tasks.total > 0 ? change.tasks.total : items.length
  const completed = change.tasks.total > 0 ? change.tasks.completed : items.filter((i) => i.done).length
  const subtitle = `tasks.md (${phase === "apply" ? `${completed}/${total}` : t(total === 1 ? "detail.taskOne" : "detail.taskMany", { n: total })})`
  if (!detail || !tasks) return { subtitle, body: missing("tasks", detail, width) }
  const body: Line[] = []
  let focus: number | undefined
  tasks.groups.forEach((g, gi) => {
    if (g.title) {
      const done = g.items.filter((i) => i.done).length
      body.push(truncateLine([seg(S1, "muted"), seg(g.title, "text", true), seg(`  ${done}/${g.items.length}`, "muted")], width))
    }
    g.items.forEach((it, ii) => {
      const current = tasks.current?.group === gi && tasks.current.item === ii
      const [mark, color]: [string, ColorKey] = current ? ["◉", "accent"] : it.done ? ["✓", "success"] : ["○", "muted"]
      const label = it.id ? `${it.id} ${it.text}` : it.text
      const now: Line = current ? [seg(`  ◀ ${t("label.now")}`, "accent", true)] : []
      const prefix: Line = [seg(S2, "muted"), seg(mark, color), seg(" ", "muted")]
      const room = width - lineWidth(prefix) - lineWidth(now)
      if (current) focus = body.length
      body.push(truncateLine([...prefix, seg(truncate(label, Math.max(1, room)), current ? "accent" : "text", current), ...now], width))
    })
  })
  if (items.length === 0) body.push(...para(t("detail.noCheckboxes"), S1, "muted", width))
  if (phase === "apply") {
    const ap = detail.applyProgress
    if (ap) {
      body.push(section(`${t("detail.progress")} · ${fileName(detail, "applyProgress")}`))
      if (ap.summary.length === 0) body.push([seg(`${S2}(${t("detail.noSummary")})`, "muted")])
      for (const s of ap.summary.slice(0, SUMMARY_MAX)) body.push(item("·", "muted", s, width))
    } else body.push(...missing("applyProgress", detail, width))
  }
  return focus === undefined ? { subtitle, body } : { subtitle, body, focus }
}

function verifyPanel(detail: SddDetail | undefined, width: number): Panel {
  const v = detail?.verify
  if (!detail || !v) return { subtitle: "verify-report.md", body: missing("verifyReport", detail, width) }
  const [mark, label, color] = verdict(v.verdict)
  const body: Line[] = [[seg(S1, "muted"), seg(mark, color, true), seg(" " + label, color, true)]]
  for (const s of v.summary.slice(0, SUMMARY_MAX)) body.push(item("·", "muted", s, width))
  if (v.summary.length > SUMMARY_MAX) body.push([seg(`${S2}${t("common.andMore", { n: v.summary.length - SUMMARY_MAX })}`, "muted")])
  return { subtitle: fileName(detail, "verifyReport"), body }
}

function archivePanel(change: SddChange, width: number): Panel {
  const body: Line[] = para(t("detail.toArchive"), S1, "text", width)
  if (change.nextRecommended) {
    body.push(...wrapWithPrefix([seg(S1, "muted"), seg(`▸ ${t("sdd.next")}:`, "accent", true), seg(" ", "muted")], change.nextRecommended, "text", width, { indent: S1.length }))
  }
  return { subtitle: "", body }
}

function panelFor(change: SddChange, detail: SddDetail | undefined, phase: SddPhaseId, width: number): Panel {
  switch (phase) {
    case "explore":
      return explorePanel(change, detail, width)
    case "propose":
      return proposePanel(detail, width)
    case "spec":
      return specPanel(detail, width)
    case "design":
      return designPanel(detail, width)
    case "tasks":
    case "apply":
      return tasksPanel(change, detail, phase, width)
    case "verify":
      return verifyPanel(detail, width)
    case "archive":
      return archivePanel(change, width)
  }
}


/**
 * Maximum scroll and initial position of a `length`-line panel in `room` lines of
 * height. The initial one leaves `focus` (the current task) a third of the way
 * down; without focus, at the top.
 */
function scrollRange(length: number, room: number, focus?: number): { initial: number; max: number } {
  if (length <= room || room <= 1) return { initial: 0, max: 0 }
  const max = length - room
  return { initial: focus === undefined ? 0 : clamp(focus - Math.floor(room / 3) - 1, 0, max), max }
}

/**
 * The `room` lines of `body` starting at `scroll`. If something is left above,
 * the first one becomes «… N more above»; if something is left below, the last
 * one becomes «… N more». Each `scroll` step moves the text by one line.
 */
function windowed(body: Line[], room: number, scroll: number): Line[] {
  if (body.length <= room) return body
  if (room <= 1) return room === 1 ? [more(body.length)] : []
  const start = clamp(scroll, 0, body.length - room)
  const shown = body.slice(start, start + room)
  if (start > 0) shown[0] = more(start + 1, true)
  if (start + room < body.length) shown[room - 1] = more(body.length - start - room + 1)
  return shown
}

// ── Screen ──────────────────────────────────────────────────────────────────

/** Beyond this width text stays on the left: right-aligned warnings do not drift away. */
export const DETAIL_MAX_WIDTH = 120

/** The screen in two parts: the fixed top and the scrollable panel body. */
type Layout = { width: number; head: Line[]; body: Line[]; focus?: number }

function layout(model: DetailModel, state: DetailState, fullWidth: number): Layout {
  const width = Math.min(fullWidth, DETAIL_MAX_WIDTH)
  const head: Line[] = [title(), rule(width)]
  if (model.error) head.push(...wrapWithPrefix([seg(" ", "muted"), seg("⚠", "warning"), seg(" ", "muted")], model.error, "warning", width, { indent: 3 }))

  if (model.changes.length === 0) {
    const message = model.loading ? t("common.loading") : t("detail.noChanges")
    return { width, head, body: para(message, " ", "muted", width) }
  }

  const s = clampDetailState(state, model.changes)
  const { status: change, detail } = model.changes[s.changeIndex]!
  const writing = model.live?.name === change.name ? model.live.writing : undefined
  head.push(...changeList(model, s.changeIndex, width), rule(width), ...phaseStrip(change, s.phase, width, writing), rule(width))

  const panel = panelFor(change, detail, s.phase, width)
  head.push(...panelHeader(change, s.phase, panel.subtitle, width))
  if (!detail && s.phase !== "archive" && s.phase !== "explore") {
    return { width, head, body: [text(`${S1}${model.loading ? t("common.loading") : t("detail.noDetail")}`, "muted")] }
  }
  return panel.focus === undefined ? { width, head, body: panel.body } : { width, head, body: panel.body, focus: panel.focus }
}

/** Lines left for the panel at `height`: the top and the key bar do not scroll. */
const roomFor = (l: Layout, height: number) => height - l.head.length - 1

function scrollOf(l: Layout, state: DetailState, height: number): PanelScroll {
  const room = roomFor(l, height)
  const { initial, max } = scrollRange(l.body.length, room, l.focus)
  return { scroll: clamp(state.scroll ?? initial, 0, max), max, page: Math.max(1, room - 1) }
}

/** Effective scroll of the panel at that height, for `reduceDetail`. */
export function panelScroll(model: DetailModel, state: DetailState, fullWidth: number, height: number): PanelScroll {
  return scrollOf(layout(model, state, fullWidth), state, height)
}

export function renderSddDetail(model: DetailModel, state: DetailState, fullWidth: number, options: DetailRenderOptions = {}): Line[] {
  const l = layout(model, state, fullWidth)
  const lines = [...l.head]
  if (options.height === undefined) lines.push(...l.body)
  else {
    lines.push(...windowed(l.body, roomFor(l, options.height), scrollOf(l, state, options.height).scroll))
    while (lines.length < options.height - 1) lines.push([])
  }
  // From the home screen there is no session to pin for: no «enter pin».
  const help = options.canPin === false ? detailHelp().filter(([key]) => key !== "enter") : detailHelp()
  lines.push(helpBar(help, l.width))
  return lines.map((line) => truncateLine(line, l.width))
}
