// Shared pieces of the text parsers (markdown, yaml, git config). Files come from
// the repository and anyone can commit a hostile one: everything here is linear
// (no regexes with overlapping quantifiers) and size-capped.

/** Longer lines are cut: no legitimate artifact needs them. */
export const MAX_LINE = 2048
/** Maximum number of items a parser collects (headings, tasks, bullets...). */
export const MAX_ITEMS = 1000
/** Maximum length of a composed text (task with continuations, paragraph). */
export const MAX_TEXT = 4096

const clipLine = (line: string) => (line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line)

/**
 * Lines with the cap applied. Also splits on `\r`, U+2028 and U+2029, so a regex
 * `.` never meets a line terminator and `(.*)$` never has to backtrack.
 */
export function splitLines(text: string): string[] {
  return (typeof text === "string" ? text : "").split(/\r\n|[\n\r\u2028\u2029]/).map(clipLine)
}

/** `text` cut to `max` characters. */
export const clip = (text: string, max = MAX_TEXT): string => (text.length > max ? text.slice(0, max) : text)

/** Appends `more` to `text` with a space while it stays under `MAX_TEXT`. */
export const appendClipped = (text: string, more: string): string => (text.length >= MAX_TEXT ? text : clip(`${text} ${more}`))

/** Removes trailing characters found in `chars` (no regex: `[...]+$` is quadratic). */
export function trimEndChars(text: string, chars: string): string {
  let end = text.length
  while (end > 0 && chars.includes(text[end - 1]!)) end--
  return end === text.length ? text : text.slice(0, end)
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)

/**
 * ATX heading: `#`×1-6, a space and the title without the closing sequence
 * (`## A ##` → «A»). Same as `/^(#{1,6})\s+(.*?)\s*#*\s*$/`, which is cubic on
 * long runs of spaces.
 */
export function parseHeading(line: string): { level: number; title: string } | undefined {
  let level = 0
  while (level < line.length && line[level] === "#") level++
  if (level < 1 || level > 6 || !isSpace(line[level])) return undefined
  const title = trimEndChars(line.slice(level).trim(), "#").trimEnd()
  return { level, title }
}

export const isHeading = (line: string): boolean => parseHeading(line) !== undefined

/** Opening or closing of a code block (``` or ~~~). */
export const FENCE = /^\s*(```|~~~)/
