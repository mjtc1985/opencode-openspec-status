// gentle-ai review: `review status` v1 (authority), `review-state.json` (internal
// format, only for the lenses) and the v2 integration (whether it applies and what
// it asks for). The v2 output may carry a ready `review start … --consent=relay`:
// no `command`, `invocation` or `arguments` field is ever copied.
// Without gentle-ai installed the section is simply absent (`none`).

import { join } from "node:path"
import { t } from "../i18n.ts"
import type { LensStatus, Review, ReviewState, ReviewStop } from "../model.ts"
import { CommandNotFoundError, parseJson, type Fsx, isInside, isObj, MAX_STATE_BYTES, nodeFs, REVIEW_CONTRACT_V2, reviewLineageArgs, reviewStatusArgs, type Run } from "./exec.ts"

export const REVIEW_STATUS_SCHEMA = "gentle-ai.review-authority-status/v1"
export const REVIEW_STATE_SCHEMA = "gentle-ai.review-state-record/v2"

export type ReviewEntry = { lineageId: string; path: string; status: string; state: string; revision: string }
export type ParsedStatus = { kind: "none" } | { kind: "incoherent"; reasons: string[] } | { kind: "entry"; entry: ReviewEntry }
export type ParsedState = { riskLevel?: string; lenses: LensStatus[] | null }
export type ParsedIntegration = { applies: Review["applies"]; stop?: ReviewStop }

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

/** The last entry not superseded; if any is `active`, the last of those. */
export function parseReviewStatus(json: unknown): ParsedStatus {
  if (!isObj(json) || json.schema !== REVIEW_STATUS_SCHEMA) {
    return { kind: "incoherent", reasons: [t("review.schemaUnknown", { schema: isObj(json) ? String(json.schema) : t("review.notAnObject") })] }
  }
  if (json.status === "clean") return { kind: "none" }
  if (!Array.isArray(json.entries)) return { kind: "incoherent", reasons: [t("review.entriesNotList")] }
  const entries: ReviewEntry[] = []
  for (const e of json.entries) {
    const lineageId = isObj(e) ? str(e.lineage_id) : undefined
    const path = isObj(e) ? str(e.path) : undefined
    const status = isObj(e) ? str(e.status) : undefined
    const state = isObj(e) ? str(e.state) : undefined
    const revision = isObj(e) ? str(e.revision) : undefined
    if (!lineageId || !path || !status || !state || !revision) {
      return { kind: "incoherent", reasons: [t("review.entryIncomplete")] }
    }
    entries.push({ lineageId, path, status, state, revision })
  }
  const live = entries.filter((e) => e.status !== "superseded")
  const active = live.filter((e) => e.status === "active")
  const pick = (active.length ? active : live).at(-1)
  return pick ? { kind: "entry", entry: pick } : { kind: "none" }
}

const SEVERE = new Set(["CRITICAL", "WARNING"])

/** Lenses from `review-state.json`; `lenses: null` if the shape is not the expected one. */
export function parseReviewState(json: unknown): ParsedState {
  const st = isObj(json) && json.schema === REVIEW_STATE_SCHEMA && isObj(json.state) ? json.state : undefined
  const riskLevel = st ? str(st.risk_level) : undefined
  const base: ParsedState = riskLevel ? { riskLevel, lenses: null } : { lenses: null }
  if (!st || !Array.isArray(st.selected_lenses) || !Array.isArray(st.admitted_role_results)) return base
  if (!st.selected_lenses.every((l) => typeof l === "string")) return base

  const results = new Map<string, number>()
  for (const r of st.admitted_role_results) {
    if (!isObj(r)) return base
    if (r.role !== "lens") continue
    const lens = str(r.lens)
    const findings = isObj(r.value) && isObj(r.value.result) ? r.value.result.findings : undefined
    if (!lens || !Array.isArray(findings)) return base
    let severe = 0
    for (const f of findings) {
      if (!isObj(f) || typeof f.severity !== "string") return base
      if (SEVERE.has(f.severity)) severe++
    }
    results.set(lens, severe)
  }

  const lenses: LensStatus[] = (st.selected_lenses as string[]).map((name) => {
    const lens = name.replace(/^review-/, "")
    const n = results.get(name)
    if (n === undefined) return { lens, status: "running" }
    return { lens, status: n === 0 ? "ok" : "findings", findings: n }
  })
  return { ...base, lenses }
}

/** Only `applicability`, `next_transition.{kind,reason_code}` and the step description. */
export function parseIntegration(json: unknown): ParsedIntegration {
  if (!isObj(json) || json.contract !== REVIEW_CONTRACT_V2) return { applies: "unknown" }
  if (json.applicability === "unrelated") return { applies: "other" }
  if (json.applicability !== "current_target") return { applies: "unknown" }
  const nt = json.next_transition
  const kind = isObj(nt) ? str(nt.kind) : undefined
  const reasonCode = isObj(nt) ? str(nt.reason_code) : undefined
  if (!kind || !reasonCode) return { applies: "current" }
  const stop: ReviewStop = { kind, reasonCode }
  const steps = isObj(json.forecast) && Array.isArray(json.forecast.steps) ? json.forecast.steps : []
  const step = steps.find((s) => isObj(s) && s.kind === kind && s.reason_code === reasonCode) as Record<string, unknown> | undefined
  const description = step && str(step.description)
  if (description) stop.description = description
  return { applies: "current", stop }
}

// ── Loader ──────────────────────────────────────────────────────────────────

/**
 * Memoizing loader: the v2 call is not repeated while the lineage and revision
 * stay the same. Only throws if `review status` v1 fails (not when gentle-ai is
 * missing: then there is simply no review).
 */
export function createReviewLoader(fsx: Fsx = nodeFs) {
  let memo: { key: string; value: ParsedIntegration } | undefined

  async function load(root: string, run: Run): Promise<ReviewState> {
    // `review status` runs `git init` in folders without git: never spawn it there.
    if (!(await fsx.exists(join(root, ".git")))) return { kind: "unavailable", reason: t("review.noGit") }

    let out: string
    try {
      out = await run("gentle-ai", reviewStatusArgs(root), { cwd: root })
    } catch (err) {
      if (err instanceof CommandNotFoundError) return { kind: "none" }
      throw err
    }
    const status = parseReviewStatus(parseJson(out))
    if (status.kind !== "entry") return status
    const e = status.entry

    let state: ParsedState = { lenses: null }
    const file = join(e.path, "review-state.json")
    if (await isInside(join(root, ".git"), file)) {
      const text = await fsx.readText(file, { maxBytes: MAX_STATE_BYTES })
      if (text !== undefined) state = parseReviewState(parseJson(text))
    }

    const key = `${root}\0${e.lineageId}\0${e.revision}`
    let integration = memo?.key === key ? memo.value : undefined
    if (!integration) {
      try {
        integration = parseIntegration(parseJson(await run("gentle-ai", reviewLineageArgs(root, e.lineageId), { cwd: root })))
        memo = { key, value: integration }
      } catch {
        integration = { applies: "unknown" }
      }
    }

    const review: Review = {
      kind: "review",
      lineageId: e.lineageId,
      state: e.state,
      entryStatus: e.status,
      lenses: state.lenses,
      applies: integration.applies,
    }
    if (state.riskLevel) review.riskLevel = state.riskLevel
    if (integration.stop) review.stop = integration.stop
    return review
  }

  return { load }
}
