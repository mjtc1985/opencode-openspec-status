// Text helpers to render lines of segments. The view's own characters take one
// column, but text from outside (titles, an ODD document's progress with ✅ ⏳,
// CJK names) may take two: every width is measured in terminal columns with
// `displayWidth`, never with `length`.
import type { ColorKey, Line, Segment } from "../model.ts"

// ── Width in columns ────────────────────────────────────────────────────────

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** `text` split into units that are measured and cut together (a ZWJ emoji is one). */
export function graphemes(text: string): string[] {
  // Fast path: without surrogates, ZWJ, variation selectors or keycaps, every
  // code point is a grapheme (lone combining marks still count 0).
  if (!/[\u200b-\u200f\u20d0-\u20ff\ud800-\udfff\ufe00-\ufe0f]/.test(text)) return [...text]
  return Array.from(segmenter.segment(text), (s) => s.segment)
}

// East Asian Wide/Fullwidth ranges (Unicode 15), without emoji, detected separately.
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f200, 0x1f2ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

const isWide = (cp: number) => WIDE_RANGES.some(([a, b]) => cp >= a && cp <= b)
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const EMOJI_BY_SELECTOR = /\p{Extended_Pictographic}\ufe0f/u
const REGIONAL_PAIR = /\p{Regional_Indicator}{2}/u
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\ufe00-\ufe0f\u{e0100}-\u{e01ef}]+$/u

/** Columns of a grapheme: 0 (marks, ZWJ, lone selectors), 1 or 2. */
function clusterWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (g.length === 1 && cp < 0x300) return 1
  if (EMOJI_PRESENTATION.test(g) || EMOJI_BY_SELECTOR.test(g) || REGIONAL_PAIR.test(g) || g.includes("\u20e3")) return 2
  if (ZERO_WIDTH.test(g)) return 0
  return isWide(cp) ? 2 : 1
}

/** Columns `text` takes in the terminal. */
export function displayWidth(text: string): number {
  let n = 0
  for (const g of graphemes(text)) n += clusterWidth(g)
  return n
}

/** The longest prefix of `text` that fits in `max` columns, without splitting graphemes. */
export function sliceToWidth(text: string, max: number): string {
  let used = 0
  let out = ""
  for (const g of graphemes(text)) {
    const w = clusterWidth(g)
    if (used + w > max) break
    used += w
    out += g
  }
  return out
}

// ── Segments and lines ──────────────────────────────────────────────────────

export const seg = (text: string, color: ColorKey, bold = false): Segment => (bold ? { text, color, bold } : { text, color })

/** Plain text of a line, for tests and debugging. */
export const lineText = (line: Line): string => line.map((s) => s.text).join("")

/** Columns a line takes. */
export const lineWidth = (line: Line): number => line.reduce((n, s) => n + displayWidth(s.text), 0)

/** Cuts `text` to `max` columns, ending with «…». */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ""
  if (displayWidth(text) <= max) return text
  if (max === 1) return "…"
  return sliceToWidth(text, max - 1).trimEnd() + "…"
}

/** Greedy word wrap; words longer than `max` are split. */
export function wrap(text: string, max: number): string[] {
  return wrapWidths(text, max, max)
}

/** Like `wrap`, but the first line may have a different width than the rest. */
function wrapWidths(text: string, first: number, rest: number): string[] {
  const lines: string[] = []
  const max = () => Math.max(1, lines.length === 0 ? first : rest)
  let current = ""
  for (let word of text.split(/\s+/).filter(Boolean)) {
    if (current && displayWidth(current) + 1 + displayWidth(word) <= max()) {
      current += " " + word
      continue
    }
    if (current) {
      lines.push(current)
      current = ""
    }
    while (displayWidth(word) > max()) {
      // A two-column character in one free column goes out whole: the final
      // line cut (`truncateLine`) takes care of it.
      const head = sliceToWidth(word, max()) || graphemes(word)[0]!
      lines.push(head)
      word = word.slice(head.length)
    }
    current = word
  }
  if (current) lines.push(current)
  return lines
}

/** Pads `line` with `fill` up to column `col` (without cutting if it is already past). */
export function padTo(line: Line, col: number, fill = " ", color: ColorKey = "muted"): Line {
  const missing = col - lineWidth(line)
  return missing > 0 ? [...line, seg(fill.repeat(missing), color)] : line
}

/** Cuts a line of segments to `max` columns, with «…» at the end. */
export function truncateLine(line: Line, max: number): Line {
  if (lineWidth(line) <= max) return line
  const out: Line = []
  let used = 0
  for (const s of line) {
    const room = max - used
    const w = displayWidth(s.text)
    if (w < room) {
      out.push(s)
      used += w
      continue
    }
    out.push({ ...s, text: truncate(s.text, room) })
    break
  }
  return out
}

export type WrapOptions = {
  /** Indentation of continuation lines. */
  indent?: number
  /** Maximum number of lines; the last one ends with «…» if text is left over. */
  maxLines?: number
  bold?: boolean
}

/**
 * A prefix (e.g. « ▸ now: ») followed by `text` wrapped to `width`; the following
 * lines are indented by `indent` columns.
 */
export function wrapWithPrefix(prefix: Line, text: string, color: ColorKey, width: number, options: WrapOptions = {}): Line[] {
  const indent = options.indent ?? 3
  const first = width - lineWidth(prefix)
  const rest = width - indent
  let lines = wrapWidths(text, first, rest)
  if (options.maxLines !== undefined && lines.length > options.maxLines) {
    lines = lines.slice(0, Math.max(1, options.maxLines))
    const last = lines.length - 1
    const max = last === 0 ? first : rest
    const text = lines[last]!
    lines[last] = displayWidth(text) < max ? text + "…" : sliceToWidth(text, max - 1).trimEnd() + "…"
  }
  if (lines.length === 0) return [prefix]
  return lines.map((t, i) => (i === 0 ? [...prefix, seg(t, color, options.bold)] : [seg(" ".repeat(indent), "muted"), seg(t, color, options.bold)]))
}

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
