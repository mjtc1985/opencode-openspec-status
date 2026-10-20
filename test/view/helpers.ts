import type { Line, Snapshot } from "../../src/model.ts"
import { compactLabel } from "../../src/view/compact.ts"
import { buildView } from "../../src/view/flow-view.ts"
import { renderFull } from "../../src/view/full.ts"
import { renderSidebar } from "../../src/view/sidebar.ts"
import { lineText } from "../../src/view/text.ts"
import { NOW } from "./snapshots.ts"

export const view = (snapshot: Snapshot) => buildView(snapshot, NOW)
export const texts = (lines: Line[]) => lines.map(lineText)
export const sidebar = (snapshot: Snapshot) => texts(renderSidebar(view(snapshot)))
export const sidebarText = (snapshot: Snapshot) => sidebar(snapshot).join("\n")
export const full = (snapshot: Snapshot, width: number) => texts(renderFull(view(snapshot), width))
export const compact = (snapshot: Snapshot) => {
  const line = compactLabel(view(snapshot))
  return line ? lineText(line) : undefined
}

/** Segments whose text contains `needle`, across all lines. */
export function segmentsWith(lines: Line[], needle: string) {
  return lines.flat().filter((s) => s.text.includes(needle))
}
