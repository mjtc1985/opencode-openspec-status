// State of the SDD detail screen: which change and phase are looked at, and how
// far the panel is scrolled. ↑↓ walk the change list (back to the new change's
// current phase), ←→ the 8 phases, home/end jump to the first or last one and
// PgUp/PgDn scroll the panel by a page. Pure: no IO, no clock.
import { SDD_PHASES, type SddChange, type SddPhaseId } from "../model.ts"
import { clamp } from "./text.ts"

/**
 * `scroll`: first visible panel line. Without it, the panel positions itself so the
 * current task is visible (and follows it as it advances); switching phase or
 * change removes it and goes back to that position.
 */
export type DetailState = { changeIndex: number; phase: SddPhaseId; scroll?: number }
export type DetailKey = "prevChange" | "nextChange" | "pageUp" | "pageDown" | "left" | "right" | "home" | "end"

/** The only thing the state needs from each change. */
export type DetailChanges = readonly { status: Pick<SddChange, "current"> }[]

/**
 * Measurements of the panel as currently drawn (`panelScroll` in `sdd-detail.ts`):
 * effective scroll, maximum and lines per page.
 */
export type PanelScroll = { scroll: number; max: number; page: number }


/** Another phase or change: no scroll of its own. */
const at = (changeIndex: number, phase: SddPhaseId): DetailState => ({ changeIndex, phase })

/** `index`: the change it opens on (the sidebar's); if it does not exist, the first one. */
export function initialDetailState(changes: DetailChanges, index = 0): DetailState {
  const i = index >= 0 && index < changes.length ? index : 0
  return at(i, changes[i]?.status.current ?? "explore")
}

/** Clamps the index if the change list shrank; the phase is kept. */
export function clampDetailState(state: DetailState, changes: DetailChanges): DetailState {
  const changeIndex = clamp(state.changeIndex, 0, Math.max(0, changes.length - 1))
  const phase = SDD_PHASES.includes(state.phase) ? state.phase : (changes[changeIndex]?.status.current ?? "explore")
  if (changeIndex === state.changeIndex && phase === state.phase) return state
  return at(changeIndex, phase)
}

/** `panel`: only PgUp/PgDn use it; without it those keys do nothing. */
export function reduceDetail(state: DetailState, key: DetailKey, changes: DetailChanges, panel?: PanelScroll): DetailState {
  const s = clampDetailState(state, changes)
  const phaseAt = SDD_PHASES.indexOf(s.phase)
  const toPhase = (phase: SddPhaseId) => (phase === s.phase ? s : at(s.changeIndex, phase))
  switch (key) {
    case "prevChange":
    case "nextChange": {
      const changeIndex = clamp(s.changeIndex + (key === "prevChange" ? -1 : 1), 0, Math.max(0, changes.length - 1))
      if (changeIndex === s.changeIndex) return s
      return at(changeIndex, changes[changeIndex]?.status.current ?? s.phase)
    }
    case "left":
    case "right":
      return toPhase(SDD_PHASES[clamp(phaseAt + (key === "left" ? -1 : 1), 0, SDD_PHASES.length - 1)]!)
    case "home":
      return toPhase(SDD_PHASES[0])
    case "end":
      return toPhase(SDD_PHASES[SDD_PHASES.length - 1]!)
    case "pageUp":
    case "pageDown": {
      if (!panel) return s
      const step = Math.max(1, panel.page)
      const current = clamp(panel.scroll, 0, panel.max)
      const scroll = clamp(current + (key === "pageUp" ? -step : step), 0, panel.max)
      return scroll === current ? s : { ...s, scroll }
    }
  }
}
