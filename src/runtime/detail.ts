// On-demand load of the `/openspec-status` SDD detail: one status per active
// change in `openspec/changes` (newest first; `gentle-ai sdd-status <change>` or,
// without gentle-ai, inferred from the files), its artifacts and the current branch
// (for pinning and to know which change the branch's work item belongs to). Never
// throws: per-change failures are summarized in `error` and the rest is still
// shown. Concurrent loads share one promise and the last model is reused for
// `cacheMs`.

import { t } from "../i18n.ts"
import type { SddChange, SddState } from "../model.ts"
import { type Fsx, type Run, nodeFs } from "../sources/exec.ts"
import { branchMatch, readCandidates } from "../sources/choice.ts"
import { type GitInfo, loadSddDetail, readGitInfo } from "../sources/sdd-detail.ts"
import { activeChanges, parseSddStatus, readSddFiles, sddStatusJson } from "../sources/sdd.ts"
import type { DetailModel } from "../view/sdd-detail.ts"

/** A bit less than the screen refresh (3 s) so every tick really reads. */
export const DETAIL_CACHE_MS = 2_500
/** At most this many `sdd-status` at once: many changes do not cause a burst. */
export const DETAIL_CONCURRENCY = 3

export type DetailLoaderOptions = {
  root: string
  run: Run
  fsx?: Fsx
  now?: () => number
  cacheMs?: number
}

export type DetailLoader = {
  /** `fallback`: the polled SDD state; without change folders, if it is a change (e.g. Engram), that one is shown. */
  load(fallback?: SddState): Promise<DetailModel>
  dispose(): void
}

type Entry = DetailModel["changes"][number]
type Outcome = { entry?: Entry; failure?: string }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)) || t("error.unknown")

/** Applies `fn` to each item with `limit` in parallel, keeping the order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function summarize(failures: string[], total: number): string | undefined {
  if (failures.length === 0) return undefined
  const head = total > 0 ? t("detail.readFailed", { failed: failures.length, total }) : t("detail.readFailedAll")
  return `${head}: ${failures.join("; ")}`
}

export function createDetailLoader(options: DetailLoaderOptions): DetailLoader {
  const { root, run } = options
  const fsx = options.fsx ?? nodeFs
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? DETAIL_CACHE_MS

  let inflight: Promise<DetailModel> | undefined
  let last: { at: number; model: DetailModel } | undefined
  let disposed = false

  /** `branchMatched`: it is the branch's change, and only it gets the branch's work item. */
  async function one(name: string, git: GitInfo, branchMatched: boolean): Promise<Outcome> {
    try {
      const { json, source } = await sddStatusJson(root, run, fsx, name)
      if (json === undefined) return { failure: `${name}: ${t("sdd.notJson")}` }
      const status = parseSddStatus(json, await readSddFiles(json, root, fsx))
      if (status.kind === "incoherent") return { failure: `${name}: ${status.reasons[0] ?? t("detail.incoherentJson")}` }
      if (status.kind === "unsupported") return { failure: `${name}: ${t("detail.unsupportedSchema", { schema: status.schema })}` }
      // «none»: the change disappeared between listing and querying.
      if (status.kind !== "change") return {}
      status.source = source
      const detail = await loadSddDetail(root, json, fsx, { git, branchMatched })
      return { entry: detail ? { status, detail } : { status } }
    } catch (err) {
      return { failure: `${name}: ${message(err)}` }
    }
  }

  async function read(fallback: SddState | undefined): Promise<DetailModel> {
    try {
      const names = await activeChanges(root, fsx)
      const git = await readGitInfo(root, fsx)
      const branch = git.branch ? { branch: git.branch } : {}
      if (names.length === 0) {
        return fallback?.kind === "change" ? { changes: [{ status: fallback as SddChange }], ...branch } : { changes: [], ...branch }
      }
      const matched = names[branchMatch(await readCandidates(root, names, fsx, git.remote), git)]
      const outcomes = await mapLimited(names, DETAIL_CONCURRENCY, (name) => one(name, git, name === matched))
      const changes = outcomes.flatMap((o) => (o.entry ? [o.entry] : []))
      const error = summarize(
        outcomes.flatMap((o) => (o.failure ? [o.failure] : [])),
        names.length,
      )
      return error ? { changes, error, ...branch } : { changes, ...branch }
    } catch (err) {
      return { changes: [], error: summarize([message(err)], 0) }
    }
  }

  return {
    load(fallback) {
      if (disposed) return Promise.resolve(last?.model ?? { changes: [] })
      if (last && now() - last.at < cacheMs) return Promise.resolve(last.model)
      if (inflight) return inflight
      const p = read(fallback)
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
