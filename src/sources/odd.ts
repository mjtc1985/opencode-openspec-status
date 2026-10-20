// `odd/tasks/<feature>.md` → `OddFeature`. There is no machine format: variation
// is tolerated (English/Spanish headings, free order, hanging indents) and it
// never throws.

import { basename, join } from "node:path"
import { t } from "../i18n.ts"
import type { OddFeature, OddState, OddTask } from "../model.ts"
import { type Pin, activePin, branchContains, isNewPin, isValidOddName } from "./choice.ts"
import { type Fsx, MAX_MARKDOWN_BYTES, isInside, nodeFs } from "./exec.ts"
import { appendClipped, parseHeading, clip, FENCE, isHeading, MAX_ITEMS, trimEndChars, splitLines } from "./markdown.ts"
import { readGitInfo } from "./sdd-detail.ts"

const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/
const TASK_ID = /^(?:\*\*)?(T\d+(?:\.\d+)*)(?:\*\*)?[:.)]?(?=\s|$)\s*/
const TASKS_SECTION = /^(tasks?|tareas?)\b/i
const NEXT_SECTION = /^(next steps?|siguientes? pasos?|pr[oó]ximos? pasos?)\b/i

/** Textual «in progress» markers: the checkbox stays unchecked. */
const IN_PROGRESS = /\((?:partial|parcial|en curso|in progress|wip)\)|\ben curso\b|\bin progress\b|\bwip\b|◉/i
// Applied with spaces already collapsed: ` ?` instead of `\s*`, which is quadratic.
const MARKER_STRIP = / ?\((?:partial|parcial|en curso|in progress|wip)\)| ?◉/gi

type Item = { done: boolean; text: string; indent: number }
type Section = { title: string; lines: string[] }

/** Strips route notes: «(route: …)» with balanced parentheses and «Route: …» to the end. */
export function stripRouteNotes(text: string): string {
  // Collapse spaces first: the regexes below never see two in a row.
  let out = clip(text).replace(/\s+/g, " ")
  for (;;) {
    const m = /\((?:route|ruta)\s*:/i.exec(out)
    if (!m) break
    let depth = 0
    let end = out.length
    for (let i = m.index; i < out.length; i++) {
      if (out[i] === "(") depth++
      else if (out[i] === ")" && --depth === 0) {
        end = i + 1
        break
      }
    }
    out = out.slice(0, m.index) + out.slice(end)
  }
  // Without parentheses only after a sentence end, so «la ruta: /api» is not cut in half.
  out = out.replace(/\s+/g, " ").replace(/(?:^|[.;] ?| [-–—] )(?:route|ruta) ?:.*$/i, "")
  return trimEndChars(out, " .;,:").trim()
}

function splitSections(lines: string[]): { h1?: string; sections: Section[] } {
  let h1: string | undefined
  const sections: Section[] = []
  let cur: Section | undefined
  let fenced = false
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced
    const h = fenced ? undefined : parseHeading(line)
    if (h?.level === 1) {
      h1 ??= h.title
      cur = undefined
      continue
    }
    if (h?.level === 2) {
      cur = { title: h.title, lines: [] }
      if (sections.length < MAX_ITEMS) sections.push(cur)
      continue
    }
    cur?.lines.push(line)
  }
  return h1 === undefined ? { sections } : { h1, sections }
}

/** Checkboxes outside code blocks, joining continuation lines. */
function checkboxes(lines: string[]): Item[] {
  const items: Item[] = []
  let open: Item | undefined
  let fenced = false
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced
      open = undefined
      continue
    }
    if (fenced) continue
    const m = CHECKBOX.exec(line)
    if (m) {
      if (items.length >= MAX_ITEMS) break
      open = { done: m[2] !== " ", text: m[3]!.trim(), indent: m[1]!.length }
      items.push(open)
      continue
    }
    if (open && line.trim() !== "" && !isHeading(line) && line.length - line.trimStart().length > open.indent) {
      open.text = appendClipped(open.text, line.trim())
      continue
    }
    open = undefined
  }
  return items
}

function firstParagraph(lines: string[]): string | undefined {
  const para: string[] = []
  for (const line of lines) {
    if (line.trim() === "") {
      if (para.length) break
      continue
    }
    if (isHeading(line)) break
    para.push(line.trim())
  }
  const text = clip(para.join(" ")).replace(/\s+/g, " ").trim()
  return text || undefined
}

const numericId = (id: string): number => {
  const m = /^T(\d+)/.exec(id)
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY
}

export function parseOddDoc(md: string, file: string): OddFeature {
  const lines = splitLines(md)
  const { h1, sections } = splitSections(lines)
  const title = (h1 ?? "").replace(/^feature\s*:\s*/i, "").trim() || basename(file).replace(/\.md$/i, "")

  const taskSection = sections.find((s) => TASKS_SECTION.test(s.title))
  let items = taskSection ? checkboxes(taskSection.lines) : []
  if (items.length === 0) items = checkboxes(lines)

  const warnings: string[] = []
  const seen = new Map<string, number>()
  let withoutId = 0
  const marked: boolean[] = []
  const tasks: OddTask[] = items.map((it, i) => {
    const m = TASK_ID.exec(it.text)
    let id: string
    let rest = it.text
    if (m) {
      id = m[1]!
      rest = it.text.slice(m[0].length)
    } else {
      id = `#${i + 1}`
      withoutId++
    }
    seen.set(id, (seen.get(id) ?? 0) + 1)
    marked.push(!it.done && IN_PROGRESS.test(it.text))
    const clean = stripRouteNotes(rest.replace(/\s+/g, " ").replace(MARKER_STRIP, ""))
    return { id, title: clean, status: it.done ? "done" : "todo" }
  })

  if (tasks.length === 0) warnings.push(t("odd.noTasks"))
  if (withoutId) warnings.push(withoutId === 1 ? t("odd.oneWithoutId") : t("odd.manyWithoutId", { n: withoutId }))
  const dups = [...seen].filter(([, n]) => n > 1).map(([id]) => id)
  if (dups.length) warnings.push(t("odd.duplicateIds", { ids: dups.join(", ") }))

  // In progress: the first with an explicit marker; otherwise the pending one with the lowest id.
  let idx = marked.indexOf(true)
  if (idx < 0) {
    let best = Number.POSITIVE_INFINITY
    tasks.forEach((task, i) => {
      const n = numericId(task.id)
      if (task.status === "todo" && (idx < 0 || n < best)) {
        idx = i
        best = n
      }
    })
  }
  if (idx >= 0) tasks[idx]!.status = "active"

  const feature: OddFeature = {
    kind: "feature",
    file,
    title,
    tasks,
    allDone: tasks.length > 0 && tasks.every((task) => task.status === "done"),
    warnings,
  }
  if (idx >= 0) feature.current = tasks[idx]
  const nextSection = sections.find((s) => NEXT_SECTION.test(s.title))
  const nextStep = nextSection && firstParagraph(nextSection.lines)
  if (nextStep) feature.nextStep = nextStep
  return feature
}

const stem = (name: string) => name.replace(/\.md$/i, "")

/** Maximum number of documents looked at in `odd/tasks/` (list in `/openspec-status`). */
export const MAX_ODD_DOCS = 50

/** A `.md` in `odd/tasks/` (`name` with the extension) and its date (0: could not be read). */
export type OddDoc = { name: string; mtime: number }
type Doc = OddDoc

/** Feature name: the document name without `.md` (what gets pinned). */
export const oddDocName = (doc: OddDoc) => stem(doc.name)

/** The `.md` files in `root`'s `odd/tasks/` (up to `MAX_ODD_DOCS`), newest first. Only lists and stats. */
export function listOddDocs(root: string, fsx: Fsx = nodeFs): Promise<OddDoc[]> {
  return listDocs(join(root, "odd", "tasks"), fsx)
}

/** The `.md` files in `odd/tasks/`, newest first. */
async function listDocs(dir: string, fsx: Fsx): Promise<Doc[]> {
  const docs = (await fsx.listDir(dir)).filter((e) => !e.dir && e.name.toLowerCase().endsWith(".md")).slice(0, MAX_ODD_DOCS)
  const stamped = await Promise.all(docs.map(async (e) => ({ name: e.name, mtime: (await fsx.mtime(join(dir, e.name))) ?? 0 })))
  return stamped.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
}

/** Reads and parses a listed document, only if it really is inside `odd/tasks/`. */
async function readDoc(dir: string, name: string, fsx: Fsx): Promise<OddFeature | undefined> {
  const file = join(dir, name)
  if (!(await isInside(dir, file))) return undefined
  const md = await fsx.readText(file, { maxBytes: MAX_MARKDOWN_BYTES })
  return md === undefined ? undefined : parseOddDoc(md, `odd/tasks/${name}`)
}

export type OddLoadOptions = {
  /** What was pinned in `/openspec-status` (from OpenCode's KV), if anything. */
  pin?: () => Pin | undefined
  /** `listOddDocs` already read in this poll (to detect new features): not listed again. */
  docs?: readonly OddDoc[]
}

/** The document date, if known (0: could not be read). */
const stampedFeature = (feature: OddFeature, doc: Doc): OddFeature => (doc.mtime > 0 ? { ...feature, updatedAt: doc.mtime } : feature)

/**
 * With an ODD feature pinned for this branch whose document still exists, that
 * document (even with no pending tasks left) with `pinned` (and `pinnedNew` if the
 * plugin pinned it because it was started in the session). Otherwise the branch's
 * `odd/tasks/` document (its name without `.md` appears in the branch name, e.g.
 * `feat/dark-mode` → `dark-mode.md`) if it still has pending tasks, with
 * `branchMatch`; otherwise the most recent one that has them. Always with
 * `updatedAt`, the document date (already read for sorting).
 */
export async function loadOdd(root: string, fsx: Fsx = nodeFs, options: OddLoadOptions = {}): Promise<OddState> {
  const dir = join(root, "odd", "tasks")
  const stamped = options.docs ?? (await listDocs(dir, fsx))
  const pin = options.pin?.()
  const pinnable = pin?.kind === "odd" && isValidOddName(pin.name)
  // The branch is only read when there is a document (to tell whether it is the branch's).
  const { branch } = stamped.length > 0 ? await readGitInfo(root, fsx) : {}
  if (pinnable) {
    const name = activePin(
      pin,
      "odd",
      branch,
      stamped.map((d) => stem(d.name)),
    )
    const doc = name !== undefined ? stamped.find((d) => stem(d.name) === name) : undefined
    const feature = doc && (await readDoc(dir, doc.name, fsx))
    if (doc && feature) return { ...stampedFeature(feature, doc), pinned: true, ...(isNewPin(pin) ? { pinnedNew: true } : {}) }
  }
  // The branch's first (longest name first); the rest, by date.
  const ofBranch = branch ? stamped.filter((d) => branchContains(branch, stem(d.name))).sort((a, b) => stem(b.name).length - stem(a.name).length) : []
  const ordered = [...ofBranch, ...stamped.filter((d) => !ofBranch.includes(d))]
  for (const d of ordered) {
    const doc = await readDoc(dir, d.name, fsx)
    if (!doc?.tasks.some((task) => task.status !== "done")) continue
    const feature = stampedFeature(doc, d)
    return ofBranch.includes(d) ? { ...feature, branchMatch: { by: "name", length: stem(d.name).length } } : feature
  }
  return { kind: "none" }
}

// ── Feature list for `/openspec-status` ────────────────────────────────────

/** An `odd/tasks/` feature on one line: what the list shows and what gets pinned. */
export type OddDocSummary = {
  /** Document name without `.md`: what is stored when pinning. */
  name: string
  file: string
  title: string
  total: number
  done: number
  /** Id of the task in progress (`T3`), if any is left. */
  current?: string
  allDone: boolean
}

export type OddListModel = { features: OddDocSummary[]; branch?: string; loading?: boolean }

export function summarizeOdd(name: string, doc: OddFeature): OddDocSummary {
  const out: OddDocSummary = {
    name,
    file: doc.file,
    title: doc.title,
    total: doc.tasks.length,
    done: doc.tasks.filter((task) => task.status === "done").length,
    allDone: doc.allDone,
  }
  if (doc.current) out.current = doc.current.id
  return out
}

/**
 * Every `odd/tasks/` feature (up to `MAX_ODD_DOCS`, bounded reads inside the
 * folder): first those with pending tasks, then the finished ones, each group
 * newest first. With the branch, for pinning.
 */
export async function listOddFeatures(root: string, fsx: Fsx = nodeFs): Promise<OddListModel> {
  const dir = join(root, "odd", "tasks")
  const stamped = await listDocs(dir, fsx)
  const read = await Promise.all(stamped.map(async (d) => ({ name: stem(d.name), doc: await readDoc(dir, d.name, fsx) })))
  const summaries = read.flatMap(({ name, doc }) => (doc && isValidOddName(name) ? [summarizeOdd(name, doc)] : []))
  const features = [...summaries.filter((f) => !f.allDone), ...summaries.filter((f) => f.allDone)]
  const { branch } = features.length > 0 ? await readGitInfo(root, fsx) : {}
  return branch ? { features, branch } : { features }
}

/** A bit less than the screen refresh (3 s), like the SDD detail. */
export const ODD_LIST_CACHE_MS = 2_500

export type OddListLoader = {
  load(): Promise<OddListModel>
  dispose(): void
}

/**
 * Loads the list for `/openspec-status`, only while the route is open: concurrent
 * loads share one promise and the last model is reused for `cacheMs`. Never
 * throws: on failure, an empty list.
 */
export function createOddListLoader(options: { root: string; fsx?: Fsx; now?: () => number; cacheMs?: number }): OddListLoader {
  const fsx = options.fsx ?? nodeFs
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? ODD_LIST_CACHE_MS
  let inflight: Promise<OddListModel> | undefined
  let last: { at: number; model: OddListModel } | undefined
  let disposed = false
  return {
    load() {
      if (disposed) return Promise.resolve(last?.model ?? { features: [] })
      if (last && now() - last.at < cacheMs) return Promise.resolve(last.model)
      if (inflight) return inflight
      const p = listOddFeatures(options.root, fsx)
        .catch((): OddListModel => ({ features: [] }))
        .then((model) => {
          last = { at: now(), model }
          return model
        })
        .finally(() => {
          inflight = undefined
        })
      inflight = p
      return p
    },
    dispose() {
      disposed = true
    },
  }
}
