// Detail of an SDD change for `/openspec-status`: what proposal, specs, design,
// tasks, apply-progress and verify-report say, plus the linked work item
// (`.openspec.yaml`, the branch when it is the change's, or the proposal) with its URL built from the
// git remote. Everything comes from reading files: no commands, no network. Parsers are pure and
// tolerant: whatever they do not understand is left out; they never throw.

import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { t } from "../i18n.ts"
import { type Fsx, isInside, isObj, MAX_GIT_BYTES, MAX_MARKDOWN_BYTES, nodeFs } from "./exec.ts"
import { appendClipped, parseHeading, clip, FENCE, isHeading, MAX_ITEMS, trimEndChars, splitLines } from "./markdown.ts"

// ── Types ───────────────────────────────────────────────────────────────────

export type DetailArtifact = "proposal" | "specs" | "design" | "tasks" | "applyProgress" | "verifyReport"
export const DETAIL_ARTIFACTS: readonly DetailArtifact[] = ["proposal", "specs", "design", "tasks", "applyProgress", "verifyReport"]

export type RequirementDelta = "added" | "modified" | "removed" | "renamed" | "unknown"
export type SpecRequirement = { title: string; delta: RequirementDelta; scenarios: number }
export type SpecDetail = { capability: string; file: string; requirements: SpecRequirement[] }

export type ProposalDetail = {
  why?: string
  changes: string[]
  capabilities: { name: string; kind: "new" | "modified" }[]
}

export type DesignDetail = { decisions: string[]; risks: string[] }

export type TaskItem = { id?: string; text: string; done: boolean }
export type TaskGroup = { title: string; items: TaskItem[] }
/** `current`: the first unchecked task (indices into `groups` and their `items`). */
export type TasksDetail = { groups: TaskGroup[]; current?: { group: number; item: number; text: string } }

export type ApplyProgressDetail = { summary: string[] }
export type VerifyDetail = { verdict: "pass" | "fail" | "unknown"; summary: string[] }

export type WorkItem = {
  /** What is shown: `AB#48213`, `PROJ-123` or the URL. */
  ref: string
  system: "azure-devops" | "jira" | "url"
  id?: string
  url?: string
  source: "openspec-yaml" | "branch" | "proposal"
}

/** Path relative to the project root and mtime (ms epoch) if it could be read. */
export type DetailFile = { path: string; mtime?: number }

export type SddDetail = {
  change: string
  /** Change folder, relative to the root (to tell where a missing artifact would go). */
  changeDir?: string
  proposal?: ProposalDetail
  specs: SpecDetail[]
  design?: DesignDetail
  tasks?: TasksDetail
  applyProgress?: ApplyProgressDetail
  verify?: VerifyDetail
  workItem?: WorkItem
  files: Record<DetailArtifact, DetailFile[]>
}

// ── Markdown ────────────────────────────────────────────────────────────────

type Heading = { level: number; title: string; key: string; line: number; end: number }

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/
const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX~-])\]\s*(.*)$/

function toLines(md: string): string[] {
  return splitLines(typeof md === "string" ? md.replace(/<!--[\s\S]*?(-->|$)/g, "") : "")
}

/** Normalized title for comparisons: lowercase, no accents, no numbering or «:». */
function keyOf(title: string): string {
  const key = stripNumber(plain(title)).normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase()
  return trimEndChars(key, ":.").trim()
}

const stripNumber = (title: string) => title.replace(/^\d+(?:\.\d+)*[.)]?\s+/, "").trim()

/** Removes the most common inline markup and collapses spaces. */
export function plain(text: string): string {
  // Each class excludes its own opening delimiter: every attempt ends at the
  // next `[`, `(` or `*`, so the whole thing is linear.
  return clip(text)
    .replace(/!?\[([^[\]]*)\]\([^()]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|[\s(])\*([^*\s](?:[^*]*?[^*\s])?)\*(?=[\s).,:;]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
}

/** Headings outside code blocks, each with the end of its section. */
function outline(lines: string[]): Heading[] {
  const out: Heading[] = []
  // Headings still open, by increasing level: the next one of level ≤ closes them.
  const open: Heading[] = []
  let fenced = false
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced
    if (fenced) return
    const m = parseHeading(line)
    if (!m) return
    while (open.length > 0 && open[open.length - 1]!.level >= m.level) open.pop()!.end = i
    // Past the cap sections keep closing, but no more are collected.
    if (out.length >= MAX_ITEMS) return
    const h = { level: m.level, title: plain(m.title), key: keyOf(m.title), line: i, end: lines.length }
    out.push(h)
    open.push(h)
  })
  return out
}

const body = (lines: string[], h: Heading) => lines.slice(h.line + 1, h.end)
const find = (heads: Heading[], re: RegExp) => heads.find((h) => re.test(h.key))

/** Direct subheadings (the first level below `h` that appears). */
function children(heads: Heading[], h: Heading): Heading[] {
  const inside = heads.filter((c) => c.line > h.line && c.line < h.end)
  // No `Math.min(...list)`: with many headings it overflows the stack.
  let level = Number.POSITIVE_INFINITY
  for (const c of inside) if (c.level < level) level = c.level
  return inside.filter((c) => c.level === level)
}

/** First-level bullets; following indented lines are joined, nested ones ignored. */
function bullets(lines: string[]): string[] {
  const items: string[] = []
  let top = -1
  let open = false
  let fenced = false
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced
    if (fenced || isHeading(line)) {
      open = false
      continue
    }
    const indent = line.length - line.trimStart().length
    const m = BULLET.exec(line)
    if (m) {
      if (top < 0 || indent <= top) {
        if (items.length >= MAX_ITEMS) break
        top = indent
        items.push(m[2]!)
        open = true
      } else open = false // nested
      continue
    }
    if (!line.trim()) continue
    if (open && indent > top) items[items.length - 1] = appendClipped(items[items.length - 1]!, line.trim())
    else open = false
  }
  return items.map(plain).filter(Boolean)
}

/** Text paragraphs (without bullets) joined into one. */
function prose(lines: string[]): string | undefined {
  const text = lines.filter((l) => l.trim() && !BULLET.test(l) && !isHeading(l) && !FENCE.test(l)).join(" ")
  return plain(clip(text)) || undefined
}

// ── Artifact parsers ────────────────────────────────────────────────────────

export function parseProposal(md: string): ProposalDetail {
  const lines = toLines(md)
  const heads = outline(lines)
  const out: ProposalDetail = { changes: [], capabilities: [] }

  const why = find(heads, /^(why|por que|motivacion|motivo|problema)\b/)
  const whyText = why ? prose(body(lines, why)) : undefined
  if (whyText) out.why = whyText

  const changes = find(heads, /^(what changes|que cambia|cambios|what)\b/)
  if (changes) out.changes = bullets(body(lines, changes))

  const caps = find(heads, /^(capabilities|capacidades)\b/)
  if (caps) {
    for (const sub of children(heads, caps)) {
      const kind = /\b(new|nuevas?)\b/.test(sub.key) ? "new" : /\bmodif/.test(sub.key) ? "modified" : undefined
      if (!kind) continue
      for (const raw of bodyBullets(lines, sub)) {
        const name = capabilityName(raw)
        if (name) out.capabilities.push({ name, kind })
      }
    }
  }
  return out
}

/** Bullets without stripping markup: the capability name goes between backticks. */
function bodyBullets(lines: string[], h: Heading): string[] {
  return body(lines, h)
    .map((l) => BULLET.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && m[1]!.length === 0)
    .slice(0, MAX_ITEMS)
    .map((m) => m[2]!)
}

function capabilityName(raw: string): string | undefined {
  const quoted = /^`([^`]+)`/.exec(raw.trim())
  if (quoted) return quoted[1]!.trim()
  const named = /^\**([a-z0-9][\w.-]*)\**\s*:/i.exec(raw.trim())
  return named ? named[1] : undefined
}

function deltaOf(key: string): RequirementDelta | undefined {
  if (/\b(added|anadid|nuev)/.test(key)) return "added"
  if (/\b(modified|modificad|cambiad)/.test(key)) return "modified"
  if (/\b(removed|eliminad|borrad|quitad)/.test(key)) return "removed"
  if (/\b(renamed|renombrad)/.test(key)) return "renamed"
  if (/(requirements?|requisitos?)\b/.test(key)) return "unknown"
  return undefined
}

const REQUIREMENT = /^(?:requirement|requisito)\s*:?\s*(.*)$/i
const SCENARIO = /^(scenario|escenario)\b/
// `(.*)` and the trailing trim kept apart: `(.*?)`?\s*$` is quadratic.
const RENAMED_TO = /^\s*(?:[-*+]\s*)?(?:\*\*)?(?:to|a|nuevo)(?:\*\*)?\s*:\s*`?#*\s*(?:requirement|requisito)?\s*:?\s*(.*)$/i
const renamedTitle = (raw: string) => trimEndChars(raw.trimEnd(), "`").trimEnd()

export function parseSpec(md: string, capability: string, file: string): SpecDetail {
  const lines = toLines(md)
  const requirements: SpecRequirement[] = []
  let delta: RequirementDelta | undefined
  let current: SpecRequirement | undefined
  let fenced = false
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced
    if (fenced) continue
    const m = parseHeading(line)
    if (!m) {
      // RENAMED: «- FROM: `### Requirement: A`» / «- TO: `### Requirement: B`».
      const to = delta === "renamed" ? RENAMED_TO.exec(line) : null
      const renamed = to ? renamedTitle(to[1]!) : ""
      if (renamed && requirements.length < MAX_ITEMS) requirements.push({ title: plain(renamed), delta: "renamed", scenarios: 0 })
      continue
    }
    const level = m.level
    const title = plain(m.title)
    if (level <= 2) {
      delta = level === 2 ? deltaOf(keyOf(title)) : undefined
      current = undefined
    } else if (level === 3) {
      const req = REQUIREMENT.exec(title)
      current = req || delta ? { title: (req ? req[1]! : title).trim() || title, delta: delta ?? "unknown", scenarios: 0 } : undefined
      if (current && requirements.length >= MAX_ITEMS) current = undefined
      if (current) requirements.push(current)
    } else if (current && SCENARIO.test(keyOf(title))) {
      current.scenarios++
    }
  }
  return { capability, file, requirements }
}

export function parseDesign(md: string): DesignDetail {
  const lines = toLines(md)
  const heads = outline(lines)
  const pick = (re: RegExp): string[] => {
    const h = find(heads, re)
    if (!h) return []
    const subs = children(heads, h)
    return subs.length > 0 ? subs.map((s) => stripNumber(s.title)).filter(Boolean) : bullets(body(lines, h))
  }
  return {
    decisions: pick(/^(decisions?|decisiones?)\b/),
    risks: pick(/^(risks?|riesgos?)\b/).map((r) => r.replace(/^\[([^\]]+)\]/, "$1")),
  }
}

const TASK_ID = /^((?:\d+\.)+\d+|[A-Z]+\d+(?:\.\d+)*|\d+)[.:)]?\s+(.*)$/

export function parseTasks(md: string): TasksDetail {
  const groups: TaskGroup[] = []
  let group: TaskGroup | undefined
  let item: { indent: number; data: TaskItem } | undefined
  let fenced = false
  for (const line of toLines(md)) {
    if (FENCE.test(line)) fenced = !fenced
    if (fenced) continue
    const h = parseHeading(line)
    if (h) {
      item = undefined
      if (h.level >= 2 && groups.length < MAX_ITEMS) {
        group = { title: plain(h.title), items: [] }
        groups.push(group)
      }
      continue
    }
    const c = CHECKBOX.exec(line)
    if (c) {
      if (group && group.items.length >= MAX_ITEMS) {
        item = undefined
        continue
      }
      if (!group) {
        group = { title: "", items: [] }
        groups.push(group)
      }
      const text = c[3]!.trim()
      const id = TASK_ID.exec(text)
      const data: TaskItem = id ? { id: id[1]!, text: id[2]!, done: /x/i.test(c[2]!) } : { text, done: /x/i.test(c[2]!) }
      group.items.push(data)
      item = { indent: c[1]!.length, data }
      continue
    }
    const indent = line.length - line.trimStart().length
    if (!line.trim()) continue
    if (item && indent > item.indent && !BULLET.test(line)) item.data.text = appendClipped(item.data.text, line.trim())
    else item = undefined
  }
  const kept = groups.filter((g) => g.items.length > 0)
  for (const g of kept) for (const it of g.items) it.text = plain(it.text)
  const out: TasksDetail = { groups: kept }
  kept.some((g, gi) =>
    g.items.some((it, ii) => {
      if (it.done) return false
      out.current = { group: gi, item: ii, text: it.id ? `${it.id} ${it.text}` : it.text }
      return true
    }),
  )
  return out
}

const PASS = /✅|✓|\bpass(?:ed|es)?\b|\bok\b|\baprobad[oa]\b|\bcumple\b|\bsuccess\b|\bcorrecto\b/i
const FAIL = /❌|✗|\bfail(?:ed|ing|s|ure)?\b|\bno pasa\b|\bno cumple\b|\brechazad[oa]\b|\bfallid[oa]\b|\bfall[oó]\b/i
const ZERO_FAIL = /\b0\s+(?:fail(?:ed|ures?|s)?|fallos?)\b|\bfail(?:ed|ures?|s)?\s*[:=]\s*0\b|\bfallos?\s*[:=]\s*0\b/gi
const VERDICT_LINE = /\b(verdict|veredicto|resultado|result|estado|status)\b/i

const hasFail = (line: string) => FAIL.test(line.replace(ZERO_FAIL, ""))
const SUMMARY_MAX = 12

function checkboxCount(lines: string[]): string | undefined {
  const boxes = lines.map((l) => CHECKBOX.exec(l)).filter((m): m is RegExpExecArray => m !== null)
  if (boxes.length === 0) return undefined
  return t("detail.checked", { done: boxes.filter((m) => /x/i.test(m[2]!)).length, total: boxes.length })
}

/** A list or table line as plain text (`plain` collapses the spaces around each `|`). */
const cell = (line: string) => plain(line.replace(/^\s*(?:[-*+]\s+|\|)/, "").split("|").join(" "))
const verdictish = (l: string) => PASS.test(l) || hasFail(l)

function summarize(lines: string[], extra: (line: string) => boolean): string[] {
  const out: string[] = []
  const count = checkboxCount(lines)
  if (count) out.push(count)
  for (const line of lines) {
    const h = parseHeading(line)
    const text = h ? (h.level >= 2 ? plain(h.title) : "") : extra(line) ? cell(line) : ""
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= SUMMARY_MAX) break
  }
  return out
}

export function parseApplyProgress(md: string): ApplyProgressDetail {
  const lines = toLines(md)
  return { summary: summarize(lines, verdictish) }
}

export function parseVerifyReport(md: string): VerifyDetail {
  const lines = toLines(md).filter((l) => !FENCE.test(l))
  let verdict: VerifyDetail["verdict"] = "unknown"
  const line = lines.find((l) => VERDICT_LINE.test(l) && verdictish(l))
  if (line) verdict = hasFail(line) ? "fail" : "pass"
  else if (lines.some(hasFail)) verdict = "fail"
  else if (lines.some((l) => PASS.test(l))) verdict = "pass"
  const summary = summarize(lines, verdictish)
  if (line) {
    const text = cell(line)
    return { verdict, summary: [text, ...summary.filter((s) => s !== text)].slice(0, SUMMARY_MAX) }
  }
  return { verdict, summary }
}

/** First-level `key: value`; no lists or nesting. */
export function parseOpenspecYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of splitLines(text)) {
    if (Object.keys(out).length >= MAX_ITEMS) break
    const m = /^([A-Za-z_][\w.-]*)\s*:(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]!.trim()
    const quoted = /^(["'])(.*)\1$/.exec(value)
    if (quoted) value = quoted[2]!
    else {
      // Comment: the first `#` preceded by a space (no `\s+#`, which is quadratic).
      const hash = /\s#/.exec(value)
      if (hash) value = value.slice(0, hash.index).trimEnd()
    }
    out[m[1]!] = value
  }
  return out
}

// ── Git and work item ───────────────────────────────────────────────────────

export type GitRemote = {
  /** Remote URL without credentials. */
  url: string
  azure?: { org: string; project: string; repo: string }
}

/**
 * Removes `user:password@` from a URL: it must never reach anything rendered.
 * Up to the last `@` before the first `/` (the password may carry an unencoded
 * `@`). In scp form (`user@host:path`) only when there is a `:` before the `@`,
 * which is a password; `git@host:org/repo` stays as is.
 */
export function stripCredentials(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/i, "$1")
  return url.replace(/^[^/\s@:]*:[^/\s]*@(?=[^/\s@:]+:)/, "")
}

const dec = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function azureOf(url: string): GitRemote["azure"] {
  const clean = stripCredentials(url.trim()).replace(/\.git$/, "")
  let m = /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(clean)
  if (m) return { org: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) }
  m = /^(?:ssh:\/\/)?(?:[^@/\s]+@)?(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i.exec(clean)
  if (m) return { org: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) }
  m = /^https?:\/\/([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(clean)
  if (m) return { org: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) }
  return undefined
}

/** `origin` remote (or the first one) from a `.git/config`. */
export function parseGitRemote(config: string): GitRemote | undefined {
  const remotes: { name: string; url: string }[] = []
  let section: string | undefined
  for (const line of splitLines(config)) {
    const s = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line)
    if (s) {
      section = s[1]
      continue
    }
    if (/^\s*\[/.test(line)) {
      section = undefined
      continue
    }
    const u = /^\s*url\s*=(.*)$/.exec(line)
    const url = u ? u[1]!.trim() : ""
    if (section && url && remotes.length < MAX_ITEMS && !remotes.some((r) => r.name === section)) remotes.push({ name: section, url })
  }
  const remote = remotes.find((r) => r.name === "origin") ?? remotes[0]
  if (!remote) return undefined
  const azure = azureOf(remote.url)
  const url = stripCredentials(remote.url)
  return azure ? { url, azure } : { url }
}

/** Branch from a `.git/HEAD`; `undefined` when detached. */
export function parseGitHead(head: string): string | undefined {
  for (const line of splitLines(head)) {
    const m = /^ref:[ \t]*refs\/heads\/(.*)$/.exec(line)
    const branch = m ? m[1]!.trim() : ""
    if (branch) return branch
  }
  return undefined
}

export function workItemUrl(item: Pick<WorkItem, "system" | "id">, remote: GitRemote | undefined): string | undefined {
  if (item.system !== "azure-devops" || !item.id || !remote?.azure) return undefined
  const { org, project } = remote.azure
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${item.id}`
}

const AB = /\bAB#(\d+)\b/i
const AZURE_ITEM_URL = /https?:\/\/(?:[^/@\s]*@)?(?:dev\.azure\.com\/[^/\s]+|[^./\s]+\.visualstudio\.com)\/[^/\s]+\/_workitems\/edit\/(\d+)[^\s)>\]]*/i
const JIRA = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9])/
const URL_ANY = /https?:\/\/[^\s)>\]]+/i
// In the branch: `feature/48213-foo`, `users/x/48213-bar`, `48213`.
const BRANCH_NUMBER = /(?:^|\/)(\d+)(?=[-_/]|$)/

function azureItem(id: string, remote: GitRemote | undefined, source: WorkItem["source"], url?: string): WorkItem {
  const item: WorkItem = { ref: `AB#${id}`, system: "azure-devops", id, source }
  const link = url ?? workItemUrl(item, remote)
  if (link) item.url = link
  return item
}

function fromYaml(value: string, remote: GitRemote | undefined): WorkItem | undefined {
  const v = value.trim()
  if (!v) return undefined
  const url = AZURE_ITEM_URL.exec(v)
  if (url) return azureItem(url[1]!, remote, "openspec-yaml", stripCredentials(url[0]))
  const ab = AB.exec(v)
  if (ab) return azureItem(ab[1]!, remote, "openspec-yaml")
  const jira = JIRA.exec(v)
  if (jira) return { ref: jira[1]!, system: "jira", id: jira[1]!, source: "openspec-yaml" }
  if (/^\d+$/.test(v) && remote?.azure) return azureItem(v, remote, "openspec-yaml")
  const any = URL_ANY.exec(v)
  if (any) {
    const clean = stripCredentials(any[0])
    return { ref: clean, system: "url", url: clean, source: "openspec-yaml" }
  }
  return undefined
}

/**
 * Work item named by the branch. A bare number (`feature/123-x`) only counts when
 * the remote is Azure DevOps, or with `anyNumber` (to compare it with the
 * `workItem` a change declares, which already says it is Azure DevOps).
 */
export function branchWorkItem(branch: string, remote: GitRemote | undefined, options: { anyNumber?: boolean } = {}): WorkItem | undefined {
  const ab = AB.exec(branch)
  if (ab) return azureItem(ab[1]!, remote, "branch")
  const jira = JIRA.exec(branch)
  if (jira) return { ref: jira[1]!, system: "jira", id: jira[1]!, source: "branch" }
  const n = BRANCH_NUMBER.exec(branch)
  if (n && (remote?.azure || options.anyNumber)) return azureItem(n[1]!, remote, "branch")
  return undefined
}

/** In free text only `AB#123` or a work item URL: a Jira-like key gives false positives. */
function fromProposal(text: string, remote: GitRemote | undefined): WorkItem | undefined {
  const url = AZURE_ITEM_URL.exec(text)
  if (url) return azureItem(url[1]!, remote, "proposal", stripCredentials(url[0]))
  const ab = AB.exec(text)
  return ab ? azureItem(ab[1]!, remote, "proposal") : undefined
}

const WORK_ITEM_KEY = /^work[_-]?item$/i

export type WorkItemInputs = { yaml?: Record<string, string>; branch?: string; proposal?: string; remote?: GitRemote }

/** Order: `workItem:` from `.openspec.yaml`, the branch and the proposal text. */
export function detectWorkItem(inputs: WorkItemInputs): WorkItem | undefined {
  const key = Object.keys(inputs.yaml ?? {}).find((k) => WORK_ITEM_KEY.test(k))
  const yaml = key ? fromYaml(inputs.yaml![key]!, inputs.remote) : undefined
  if (yaml) return yaml
  const branch = inputs.branch ? branchWorkItem(inputs.branch, inputs.remote) : undefined
  if (branch) return branch
  return inputs.proposal ? fromProposal(inputs.proposal, inputs.remote) : undefined
}

// ── Loader ──────────────────────────────────────────────────────────────────

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [])

/** Absolute path inside `root`, or `undefined` if it escapes (`..`, another root). Lexical only. */
export function insideRoot(root: string, path: string): string | undefined {
  const base = resolve(root)
  const abs = resolve(base, path)
  return abs === base || abs.startsWith(base + sep) ? abs : undefined
}

/** Like `insideRoot`, but also with real paths: a link escaping `root` does not count. */
async function realInsideRoot(root: string, path: string): Promise<string | undefined> {
  const abs = insideRoot(root, path)
  return abs !== undefined && (await isInside(root, abs, { orSame: true })) ? abs : undefined
}

/** Reads `path` only if, once resolved, it stays inside `root`. */
async function readInside(fsx: Fsx, root: string, path: string): Promise<string | undefined> {
  return (await isInside(root, path)) ? fsx.readText(path, { maxBytes: MAX_MARKDOWN_BYTES }) : undefined
}

const readGitFile = (fsx: Fsx, path: string) => fsx.readText(path, { maxBytes: MAX_GIT_BYTES })

/** Branch (none if HEAD is detached) and remote of the project. */
export type GitInfo = { branch?: string; remote?: GitRemote }

/** Branch and remote from `.git/HEAD` and `.git/config` (or those of `gitdir:` when `.git` is a file). */
export async function readGitInfo(root: string, fsx: Fsx = nodeFs): Promise<GitInfo> {
  const dotgit = join(resolve(root), ".git")
  const asFile = await readGitFile(fsx, dotgit)
  const pointer = asFile !== undefined ? splitLines(asFile).map((l) => /^gitdir:(.*)$/.exec(l)?.[1]?.trim()).find(Boolean) : undefined
  if (asFile !== undefined && !pointer) return {}
  const gitdir = pointer ? resolve(resolve(root), pointer) : dotgit
  // Only these two fixed names are read inside the gitdir.
  const [head, config] = await Promise.all([readGitFile(fsx, join(gitdir, "HEAD")), readGitFile(fsx, join(gitdir, "config"))])
  const out: GitInfo = {}
  const branch = head !== undefined ? parseGitHead(head) : undefined
  if (branch) out.branch = branch
  const remote = config !== undefined ? parseGitRemote(config) : undefined
  if (remote) out.remote = remote
  return out
}

/** Capability name: the folder in `specs/<cap>/spec.md`. */
function capabilityOf(file: string): string {
  const parts = file.split(/[\\/]/)
  const i = parts.lastIndexOf("specs")
  if (i >= 0 && i < parts.length - 2) return parts[i + 1]!
  return basename(dirname(file)) || basename(file)
}

export type SddDetailOptions = {
  /**
   * The branch is this change's (`branchMatch` in `choice.ts`): only then is the
   * branch's work item attributed to it. Otherwise each change shows only its own.
   */
  branchMatched?: boolean
  /** Branch and remote already read (the loader reads them once for all changes). */
  git?: GitInfo
}

/**
 * Detail of a change from the `sdd-status` JSON (the whole object, or at least
 * `changeName`, `changeRoot` and `artifactPaths`). Only reads files inside
 * `root`; `undefined` if the JSON names no change.
 */
export async function loadSddDetail(root: string, status: unknown, fsx: Fsx = nodeFs, options: SddDetailOptions = {}): Promise<SddDetail | undefined> {
  if (!isObj(status) || typeof status.changeName !== "string" || !status.changeName) return undefined
  const base = resolve(root)
  const rel = (abs: string) => relative(base, abs) || "."
  const ap = isObj(status.artifactPaths) ? status.artifactPaths : {}
  const paths = {} as Record<DetailArtifact, string[]>
  for (const k of DETAIL_ARTIFACTS) {
    const inside = await Promise.all(strs(ap[k]).slice(0, MAX_ITEMS).map((p) => realInsideRoot(base, p)))
    paths[k] = inside.filter((p): p is string => p !== undefined)
  }

  const detail: SddDetail = { change: status.changeName, specs: [], files: {} as SddDetail["files"] }
  const changeRoot = typeof status.changeRoot === "string" ? await realInsideRoot(base, status.changeRoot) : undefined
  if (changeRoot) detail.changeDir = rel(changeRoot)

  await Promise.all(
    DETAIL_ARTIFACTS.map(async (k) => {
      detail.files[k] = await Promise.all(
        paths[k].map(async (p) => {
          const mtime = await fsx.mtime(p)
          return mtime === undefined ? { path: rel(p) } : { path: rel(p), mtime }
        }),
      )
    }),
  )

  const first = (k: DetailArtifact) => (paths[k][0] ? readInside(fsx, base, paths[k][0]) : Promise.resolve(undefined))
  const [proposal, design, tasks, apply, verify, yamlText, git] = await Promise.all([
    first("proposal"),
    first("design"),
    first("tasks"),
    first("applyProgress"),
    first("verifyReport"),
    changeRoot ? readInside(fsx, base, join(changeRoot, ".openspec.yaml")) : Promise.resolve(undefined),
    options.git ?? readGitInfo(base, fsx),
  ])
  if (proposal !== undefined) detail.proposal = parseProposal(proposal)
  if (design !== undefined) detail.design = parseDesign(design)
  if (tasks !== undefined) detail.tasks = parseTasks(tasks)
  if (apply !== undefined) detail.applyProgress = parseApplyProgress(apply)
  if (verify !== undefined) detail.verify = parseVerifyReport(verify)

  const specs = await Promise.all(paths.specs.map(async (p) => ({ p, md: await readInside(fsx, base, p) })))
  for (const { p, md } of specs) if (md !== undefined) detail.specs.push(parseSpec(md, capabilityOf(rel(p)), rel(p)))

  const workItem = detectWorkItem({
    ...(yamlText !== undefined ? { yaml: parseOpenspecYaml(yamlText) } : {}),
    ...(git.branch && options.branchMatched ? { branch: git.branch } : {}),
    ...(proposal !== undefined ? { proposal } : {}),
    ...(git.remote ? { remote: git.remote } : {}),
  })
  if (workItem) detail.workItem = workItem
  return detail
}
