// Pieces shared by the sections: header, « ▸ label: …» lines, marked lines,
// times, relative paths and the key bar of the full screen.
import { t } from "../i18n.ts"
import type { ColorKey, Line } from "../model.ts"
import { displayWidth, lineWidth, seg, truncate, truncateLine, wrapWithPrefix } from "./text.ts"

/** Product name shown in headers. */
export const PRODUCT = "openspec-status"

export const INDENT = "   " // the node mark falls on column 3

export type RenderOptions = { full: boolean }

export function header(title: string, name: string, width: number, suffix = ""): Line {
  const prefix = [seg(" ", "muted"), seg("◆", "accent"), seg(" ", "muted"), seg(title, "text", true)]
  if (!name) return prefix
  const room = width - lineWidth(prefix) - 3 - displayWidth(suffix)
  const line = [...prefix, seg(" · ", "muted"), seg(truncate(name, Math.max(1, room)), "text")]
  return suffix ? [...line, seg(suffix, "muted")] : line
}

/** Indented line with a « ▸ label: » prefix and wrapped text. */
export function labelled(label: string, text: string, width: number, options: { color?: ColorKey; labelColor?: ColorKey; maxLines?: number } = {}): Line[] {
  const prefix = [seg(" ", "muted"), seg(`▸ ${label}:`, options.labelColor ?? "accent", true), seg(" ", "muted")]
  return wrapWithPrefix(prefix, text, options.color ?? "text", width, { indent: 3, ...(options.maxLines ? { maxLines: options.maxLines } : {}) })
}

/** Wrapped « <mark> text» line, with continuation indent 3. */
export function marked(mark: string, markColor: ColorKey, text: string, color: ColorKey, width: number, maxLines?: number): Line[] {
  const prefix = [seg(" ", "muted"), seg(mark, markColor), seg(" ", "muted")]
  return wrapWithPrefix(prefix, text, color, width, { indent: 3, ...(maxLines ? { maxLines } : {}) })
}

const pad2 = (n: number) => String(n).padStart(2, "0")
export function clock(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Path relative to the project root when inside it; otherwise as is. */
export function relative(root: string, file: string): string {
  const base = root.endsWith("/") ? root : root + "/"
  return file.startsWith(base) ? file.slice(base.length) : file
}

/** A key and what it does, for the help bar: `["esc", "back"]`. */
export type HelpItem = readonly [key: string, action: string]

const helpPart = ([key, action]: HelpItem, first: boolean): Line => [...(first ? [] : [seg("  ", "muted")]), seg(key, "muted", true), seg(" " + action, "muted")]

/**
 * Muted key bar, with the keys in bold. The last one (the exit key) always keeps
 * its place; of the rest, when they do not all fit, those that do not fit are
 * skipped and the following, shorter ones are tried.
 */
export function helpBar(items: readonly HelpItem[], width: number): Line {
  const last = items.at(-1)
  const reserved = last ? lineWidth(helpPart(last, items.length === 1)) : 0
  const line: Line = [seg(" ", "muted")]
  for (const item of items.slice(0, -1)) {
    const part = helpPart(item, line.length === 1)
    if (lineWidth(line) + lineWidth(part) + reserved <= width) line.push(...part)
  }
  if (last) line.push(...helpPart(last, line.length === 1))
  return truncateLine(line, width)
}

/** Mark of what is pinned: «pinned» by hand, «new» when the jump to work started in the session pinned it. */
export const pinLabel = (isNew?: boolean): string => t(isNew ? "pin.new" : "pin.pinned")
