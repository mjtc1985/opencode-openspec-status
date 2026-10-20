// SDD flow diagram: one node per phase, the current phase (or the one the agent is
// writing, with its clock) inside a thin box, the per-task apply loop (with the way
// back from verify) and the «changed after …» arrow when an earlier artifact was
// touched after a later one.
import { listOf, t } from "../i18n.ts"
import { SDD_PHASES, type ColorKey, type Line, type PhaseStatus, type SddPhaseId } from "../model.ts"
import { type FlowView, type SddChangeView, type StalePair, workingClock } from "./flow-view.ts"
import { autoLabel, autoReason } from "./focus.ts"
import { clock, header, INDENT, labelled, marked, pinLabel, relative, type RenderOptions } from "./parts.ts"
import { lineText, lineWidth, padTo, seg, truncateLine } from "./text.ts"

const BOX_INNER = 22
const STALE_COL = 19 // column of the drift arrow
const LOOP_COL = 27 // column of the apply ↔ verify loop
const BAR = 16
const SIDEBAR_BLOCKED = 2

export const MARK: Record<PhaseStatus, [string, ColorKey]> = {
  done: ["✓", "success"],
  active: ["◉", "accent"],
  todo: ["○", "muted"],
  blocked: ["✗", "error"],
}

/** A diagram row: variants from most to least complete; the box is never cut. */
type Row = { variants: Line[]; box: boolean }

const stem = (color: ColorKey = "muted"): Row => ({ variants: [[seg(INDENT, "muted"), seg("▼", color)]], box: false })

/** First variant that fits in `max` columns. */
function pick(row: Row, max: number): Line | undefined {
  return row.variants.find((v) => lineWidth(v) <= max)
}

function progressText(view: SddChangeView): string {
  const { total, completed } = view.change.tasks
  return total > 0 ? `${completed}/${total}` : ""
}

function progressBar(completed: number, total: number): Line {
  let filled = Math.round((completed / total) * BAR)
  if (completed > 0) filled = Math.max(1, filled)
  if (completed < total) filled = Math.min(BAR - 1, filled)
  filled = Math.max(0, Math.min(BAR, filled))
  return [seg("█".repeat(filled), "accent"), seg("░".repeat(BAR - filled), "muted")]
}

function nodeRow(view: SddChangeView, phase: SddPhaseId): Row {
  const status = view.change.phases[phase]
  const [mark, color] = MARK[status]
  const base: Line = [seg(INDENT, "muted"), seg(mark, color), seg(" " + phase, status === "todo" ? "muted" : "text")]
  const progress = phase === "apply" ? progressText(view) : ""
  const count: Line = progress ? [seg("  " + progress, "muted")] : []
  const note: Line = phase === view.change.next && !view.continueCurrent ? [seg(`  ▸ ${t("sdd.next")}`, "accent")] : []
  return { variants: [[...base, ...count, ...note], [...base, ...note], [...base, ...count], base], box: false }
}

function boxed(inner: Line, width = BOX_INNER): Line {
  return [seg(" │", "accent"), ...padTo(truncateLine(inner, width), width, " ", "muted"), seg("│", "accent")]
}

/** What the OpenCode session adds to the box: phase in progress, agent working or waiting for you. */
type BoxActivity = { clock: string; working: boolean; awaitingOk: boolean }

function boxActivity(flow: FlowView, view: SddChangeView): BoxActivity {
  return {
    clock: workingClock(flow),
    working: flow.activity?.state === "busy" && view.writing === undefined,
    awaitingOk: view.awaitingOk,
  }
}

const withClock = (text: string, clock: string) => (clock ? `${text} ${clock}` : text)

/** «◀ you are here» under the box, with « · waiting for you» when it applies. */
function hereRows(phase: SddPhaseId, activity: BoxActivity, width: number): Row[] {
  const here = seg(`  ◀ ${t("sdd.youAreHere")}`, "accent", true)
  if (!activity.awaitingOk) return [{ variants: [[seg(INDENT, "muted"), seg("▼", "accent"), here]], box: false }]
  const oneRow: Line = [seg(INDENT, "muted"), seg("▼", "accent"), here, seg(` · ${t("live.waiting")}`, "warning")]
  // Under apply runs the loop (column 27), and a long translation may not fit
  // either: then it moves to the next row.
  if (phase === "apply" || lineWidth(oneRow) > width) {
    return [
      { variants: [[seg(INDENT, "muted"), seg("│", "accent"), here]], box: false },
      { variants: [[seg(INDENT, "muted"), seg("▼", "accent"), seg(`    ${t("live.waiting")}`, "warning")]], box: false },
    ]
  }
  return [{ variants: [oneRow], box: false }]
}

/**
 * Rows of the box of the current phase (or the one in progress); `content` is the
 * relative index of the name row.
 */
function boxRows(view: SddChangeView, phase: SddPhaseId, last: boolean, activity: BoxActivity, width: number): { rows: Row[]; content: number } {
  const status = view.change.phases[phase]
  const writing = view.writing === phase
  const [mark, color] = writing ? MARK.active : MARK[status]
  const progress = phase === "apply" ? progressText(view) : ""
  const inner: Line = [seg(" ", "muted"), seg(mark, color), seg(" ", "muted"), seg(phase, "accent", true)]
  if (progress) inner.push(seg("  " + progress, "text"))
  const content = boxed(inner)
  const rows: Row[] = [{ variants: [[seg(" ┌" + "─".repeat(BOX_INNER) + "┐", "accent")]], box: true }]
  rows.push({ variants: [last ? [...content, seg(` ◀ ${t("sdd.youAreHere")}`, "accent", true)] : content], box: true })
  const { total, completed } = view.change.tasks
  if (phase === "apply" && total > 0) rows.push({ variants: [boxed([seg("   ", "muted"), ...progressBar(completed, total)])], box: true })
  if (writing) {
    const clock: Line = activity.clock ? [seg(" " + activity.clock, "text")] : []
    rows.push({ variants: [boxed([seg("   ", "muted"), seg(t("sdd.writing"), "accent"), ...clock])], box: true })
  }
  const bottom = last ? " └" + "─".repeat(BOX_INNER) + "┘" : " └─┬" + "─".repeat(BOX_INNER - 2) + "┘"
  rows.push({ variants: [[seg(bottom, "accent")]], box: true })
  if (last) return { rows, content: 1 }
  if (activity.working) {
    // Working without having touched an artifact recently: the note, under the box.
    // If the apply loop runs on the right, the short version.
    const note = (text: string): Line => [seg(INDENT, "muted"), seg("│", "accent"), seg("  " + withClock(text, activity.clock), "muted")]
    rows.push({ variants: [note(t("sdd.agentWorking")), note(t("live.working"))], box: false })
  }
  rows.push(...hereRows(phase, activity, width))
  return { rows, content: 1 }
}

/** What to do depending on the drifted phase («review apply» said nothing useful). */
function staleAction(phase: SddPhaseId): string {
  if (phase === "apply") return t("stale.actionApply")
  if (phase === "verify") return t("stale.actionVerify")
  return t("stale.actionReview", { phase })
}

/** Drift summary on the first affected artifact (pairs come sorted already). */
export function staleSummary(pairs: StalePair[]): string {
  const down = pairs[0]!.downstream
  const ups = SDD_PHASES.filter((p) => pairs.some((x) => x.downstream === down && x.upstream === p))
  const later = pairs.some((x) => x.downstream !== down)
  const changed = t(ups.length > 1 ? "stale.changedMany" : "stale.changedOne", { what: listOf(ups), after: down })
  return `${changed} → ${staleAction(down)}${later ? ` ${t("stale.andWhatFollows")}` : ""}`
}

/** Can the drift arrow be drawn without overwriting anything? Only towards `tasks`, which has no loop. */
function arrowFits(rows: Row[], from: number, to: number): boolean {
  if (from >= to - 1 || rows[from]!.box || rows[to]!.box) return false
  if (lineWidth(rows[from]!.variants[0]!) > STALE_COL - 2) return false
  for (let i = from + 1; i < to; i++) {
    if (rows[i]!.box || lineWidth(rows[i]!.variants[0]!) > STALE_COL - 1) return false
  }
  return true
}

const loopNote = () => t("sdd.perTask")

function diagram(flow: FlowView, view: SddChangeView, width: number): { lines: Line[]; arrow?: StalePair } {
  const { change } = view
  // The box goes to the phase in progress, if any; otherwise to the current one.
  const boxedPhase = view.writing ?? change.current
  const activity = boxActivity(flow, view)
  const rows: Row[] = []
  const at: Partial<Record<SddPhaseId, number>> = {}
  SDD_PHASES.forEach((phase, i) => {
    const last = i === SDD_PHASES.length - 1
    const previousBoxed = i > 0 && SDD_PHASES[i - 1] === boxedPhase
    if (i > 0 && !previousBoxed) rows.push(stem())
    if (phase === boxedPhase) {
      const box = boxRows(view, phase, last, activity, width)
      at[phase] = rows.length + box.content
      rows.push(...box.rows)
    } else {
      at[phase] = rows.length
      rows.push(nodeRow(view, phase))
    }
  })
  const out: (Line | undefined)[] = rows.map(() => undefined)

  // Apply loop: «◀─┐» on apply, «│ per task» in between, «──┘ fails» on verify.
  const a = at.apply!
  const v = at.verify!
  const loop: ColorKey = view.applyLoopHot ? "accent" : "muted"
  {
    const row = rows[a]!
    const left = row.box ? row.variants[0]! : [...(pick(row, LOOP_COL - 4) ?? row.variants.at(-1)!), seg(" ", "muted")]
    out[a] = [...padTo([...left, seg("◀", loop)], LOOP_COL, "─", loop), seg("┐", loop)]
    const between = v - a - 1
    // With a single row in between (apply outside the box), «per task» right of the
    // loop may exceed 36 columns: then it goes to its left.
    const noteLeft = between === 1 && LOOP_COL + 2 + loopNote().length > width
    const notes = between >= 2 ? t("sdd.perTask").split(" ", 2) : [loopNote()]
    for (let i = a + 1; i < v; i++) {
      const note = notes[i - a - 1]
      const left = pick(rows[i]!, LOOP_COL - 1) ?? rows[i]!.variants.at(-1)!
      if (note && noteLeft && lineWidth(left) <= LOOP_COL - 2 - note.length) {
        out[i] = [...padTo(left, LOOP_COL - 1 - note.length), seg(note + " ", loop), seg("│", loop)]
        continue
      }
      const line = [...padTo(left, LOOP_COL), seg("│", loop)]
      out[i] = note ? [...line, seg(" " + note, loop)] : line
    }
    const vrow = rows[v]!
    const vleft = vrow.box ? vrow.variants[0]! : [...(pick(vrow, LOOP_COL - 3) ?? vrow.variants.at(-1)!), seg(" ", "muted")]
    out[v] = [...padTo(vleft, LOOP_COL, "─", "muted"), seg("┘", "muted"), seg(` ${t("sdd.fails")}`, "muted")]
  }

  // Drift arrow for the most important warning, if it fits.
  let arrow: StalePair | undefined
  const first = view.stalePairs[0]
  if (first && first.downstream === "tasks") {
    const from = at[first.upstream]!
    const to = at.tasks!
    if (arrowFits(rows, from, to)) {
      arrow = first
      out[from] = [...padTo([...rows[from]!.variants[0]!, seg(" ", "muted")], STALE_COL, "─", "warning"), seg(`┐ ⚠ ${t("stale.arrowChanged")}`, "warning")]
      for (let i = from + 1; i < to; i++) {
        const line = [...padTo(rows[i]!.variants[0]!, STALE_COL), seg(i === to - 1 ? "▼" : "│", "warning")]
        out[i] = i === from + 1 ? [...line, seg(`   ${t("stale.arrowAfter", { phase: first.downstream })}`, "warning")] : line
      }
      out[to] = [...rows[to]!.variants[0]!, seg(` ◀─ ${t("stale.arrowReview")}`, "warning")]
    }
  }

  return { lines: rows.map((row, i) => out[i] ?? row.variants[0]!), ...(arrow ? { arrow } : {}) }
}

/**
 * `(1 of 6 · branch)`: how many changes there are and why this one is shown. With
 * the sidebar focused on SDD because it is the most recent (`auto`), also
 * `· recent`; pinned because it is new (`isNew`), `· new` instead of `· pinned`.
 */
export function choiceLabel(choice: NonNullable<SddChangeView["change"]["choice"]>, auto?: "branch" | "recent", isNew?: boolean): string {
  const reason = choice.reason ?? "recent"
  let why = ""
  if (reason === "pinned") why = ` · ${pinLabel(isNew)}`
  else if (reason === "branch") why = ` · ${autoLabel("branch")}`
  else if (auto === "recent") why = ` · ${autoLabel("recent")}`
  return `(${t("sdd.nOfTotal", { n: choice.index, total: choice.total })}${why})`
}

/** Header with the name; if the name does not fit next to `(1 of 6 · branch)`, `(pinned)`, `(new)` or `(branch)`, that moves to its own line. */
function changeHeader(change: SddChangeView["change"], width: number, auto?: "branch" | "recent"): Line[] {
  // A single active change: `(pinned)`, `(new)` or the automatic focus reason, without «1 of 1».
  const single = change.pinned ? pinLabel(change.pinnedNew) : auto ? autoLabel(auto) : undefined
  let label = change.choice ? choiceLabel(change.choice, auto, change.pinnedNew) : single ? `(${single})` : undefined
  // Without gentle-ai the status is inferred from the OpenSpec files: say so.
  if (change.source === "files") label = label ? `${label.slice(0, -1)} · ${t("common.inferred")})` : `(${t("common.inferred")})`
  if (!label) return [header("SDD", change.name, width)]
  const whole = header("SDD", change.name, width, " " + label)
  if (lineText(whole).includes(change.name)) return [whole]
  return [header("SDD", change.name, width), [seg(INDENT, "muted"), seg(label, "muted")]]
}

function changeLines(view: FlowView, sdd: SddChangeView, width: number, options: RenderOptions): Line[] {
  const { change } = sdd
  const lines: Line[] = [...changeHeader(change, width, autoReason(view, "sdd")), []]
  const { lines: drawn, arrow } = diagram(view, sdd, width)
  lines.push(...drawn)

  const below: Line[] = []
  if (change.stale === "unavailable") {
    below.push(...marked(" ", "muted", t("stale.unavailable", { store: change.store }), "muted", width))
  } else if (options.full) {
    for (const pair of sdd.stalePairs) {
      for (const w of pair.warnings) {
        const text = t("stale.fileChanged", { upstream: `${relative(view.root, w.upstreamFile)} (${clock(w.upstreamMtime)})`, downstream: `${relative(view.root, w.downstreamFile)} (${clock(w.downstreamMtime)})` })
        below.push(...marked("⚠", "warning", text, "warning", width))
      }
    }
  } else if (sdd.stalePairs.length > 0 && !(arrow && sdd.stalePairs.length === 1)) {
    // A single warning: everything after the first affected artifact derives from
    // it, so listing every pair would only hide what to review first.
    below.push(...marked("⚠", "warning", staleSummary(sdd.stalePairs), "warning", width))
  }
  const blocked = options.full ? change.blocked : change.blocked.slice(0, SIDEBAR_BLOCKED)
  for (const reason of blocked) below.push(...marked("✗", "error", reason, "error", width, options.full ? undefined : 2))
  if (change.blocked.length > blocked.length) below.push([seg(`   ${t("common.andMore", { n: change.blocked.length - blocked.length })}`, "muted")])
  if (options.full) {
    for (const note of change.notes) below.push(...marked("·", "muted", note, "muted", width))
    if (change.choice && change.choice.others.length > 0) below.push(...marked(" ", "muted", t("sdd.otherChanges", { names: change.choice.others.join(", ") }), "muted", width))
    below.push(...marked(" ", "muted", t("sdd.store", { store: change.store }), "muted", width))
  }
  if (below.length > 0) lines.push([], ...below)

  const footer: Line[] = []
  const maxLines = options.full ? undefined : 2
  if (change.currentTask) footer.push(...labelled(t("label.now"), change.currentTask, width, { maxLines }))
  let next = ""
  if (sdd.continueCurrent) {
    next = t("sdd.continue", { phase: change.current }) + (change.current === "apply" && change.tasks.pending > 0 ? ` (${t("sdd.left", { n: change.tasks.pending })})` : "")
  } else {
    next = change.next ?? change.nextRecommended
  }
  if (next) footer.push(...labelled(t("label.then"), next, width, { maxLines, labelColor: "muted" }))
  if (footer.length > 0) lines.push([], ...footer)
  return lines
}

/** Whole SDD section (header, diagram, warnings and footer); empty without SDD. */
export function renderSdd(view: FlowView, width: number, options: RenderOptions): Line[] {
  const sdd = view.sdd
  switch (sdd.kind) {
    case "none":
      return []
    case "incoherent": {
      const reasons = options.full ? sdd.reasons : sdd.reasons.slice(0, 3)
      const lines: Line[] = [header("SDD", "", width), [], [seg(" ", "muted"), seg(`⚠ ${t("sdd.incoherentTitle")}`, "warning", true)]]
      for (const reason of reasons) lines.push(...marked("·", "warning", reason, "warning", width, options.full ? undefined : 2))
      if (sdd.reasons.length > reasons.length) lines.push([seg(`   ${t("common.andMore", { n: sdd.reasons.length - reasons.length })}`, "muted")])
      return lines
    }
    case "unsupported":
      return [header("SDD", "", width), [], ...marked("⚠", "warning", t("sdd.unknownFormat", { schema: sdd.schema }), "warning", width)]
    case "change":
      return changeLines(view, sdd, width, options)
  }
}
