import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ReviewState } from "../../src/model.ts"
import { type Run, reviewLineageArgs, reviewStatusArgs } from "../../src/sources/exec.ts"
import { createReviewLoader, parseIntegration, parseReviewState, parseReviewStatus } from "../../src/sources/review.ts"

const FIX = join(import.meta.dir, "..", "fixtures")
const raw = (name: string) => readFileSync(join(FIX, name), "utf8")
const fixture = (name: string) => JSON.parse(raw(name)) as Record<string, any>

const tmp = mkdtempSync(join(tmpdir(), "openspec-status-review-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const SAMPLE_APP = "/home/dev/projects/sample-app"

describe("parseReviewStatus (v1)", () => {
  test("clean: none", () => {
    expect(parseReviewStatus(fixture("review-venue-finder.json"))).toEqual({ kind: "none" })
    expect(parseReviewStatus(fixture("review-pricing-service.json"))).toEqual({ kind: "none" })
    expect(parseReviewStatus(fixture("review-synthetic-fresh-git-empty.json"))).toEqual({ kind: "none" })
  })

  test("sample-app: the recovered entry, not the superseded one", () => {
    expect(parseReviewStatus(fixture("review-sample-app.json"))).toEqual({
      kind: "entry",
      entry: {
        lineageId: "review-ff3e92437e221e59-r1",
        path: `${SAMPLE_APP}/.git/gentle-ai/review-transactions/v2/review-ff3e92437e221e59-r1`,
        status: "recovered",
        state: "correction_required",
        revision: "sha256:a6c2aa898023c971087bd90f90957a9b33a77cabd1697924811023d5cce62175",
      },
    })
  })

  test("prefers the last active one even if others follow", () => {
    const j = fixture("review-sample-app.json")
    j.entries[0].status = "active"
    const s = parseReviewStatus(j)
    expect(s.kind === "entry" && s.entry.lineageId).toBe("review-ff3e92437e221e59")
  })

  test("all superseded: none", () => {
    const j = fixture("review-sample-app.json")
    j.entries[1].status = "superseded"
    expect(parseReviewStatus(j)).toEqual({ kind: "none" })
  })

  test("unknown schema or broken entries: incoherent", () => {
    expect(parseReviewStatus({ ...fixture("review-sample-app.json"), schema: "otro/v9" }).kind).toBe("incoherent")
    expect(parseReviewStatus(null).kind).toBe("incoherent")
    const j = fixture("review-sample-app.json")
    delete j.entries[1].revision
    expect(parseReviewStatus(j).kind).toBe("incoherent")
  })
})

describe("parseReviewState (lenses)", () => {
  test("sample-app r1: high risk and CRITICAL+WARNING findings per lens", () => {
    expect(parseReviewState(fixture("review-state-sample-app-r1.json"))).toEqual({
      riskLevel: "high",
      lenses: [
        { lens: "risk", status: "findings", findings: 3 },
        { lens: "resilience", status: "findings", findings: 2 },
        { lens: "readability", status: "findings", findings: 4 },
        { lens: "reliability", status: "findings", findings: 1 },
      ],
    })
  })

  test("reviewing: lens without a result → running", () => {
    const j = fixture("review-state-sample-app-r1.json")
    j.state.state = "reviewing"
    j.state.admitted_role_results = j.state.admitted_role_results.filter((r: any) => r.lens === "review-risk")
    expect(parseReviewState(j).lenses).toEqual([
      { lens: "risk", status: "findings", findings: 3 },
      { lens: "resilience", status: "running" },
      { lens: "readability", status: "running" },
      { lens: "reliability", status: "running" },
    ])
  })

  test("approved: suggestions only → ok", () => {
    const j = fixture("review-state-sample-app-r1.json")
    j.state.state = "approved"
    j.state.risk_level = "medium"
    j.state.selected_lenses = ["review-reliability"]
    for (const r of j.state.admitted_role_results) {
      if (r.role === "lens") r.value.result.findings = r.value.result.findings.map((f: any) => ({ ...f, severity: "SUGGESTION" }))
    }
    expect(parseReviewState(j)).toEqual({ riskLevel: "medium", lenses: [{ lens: "reliability", status: "ok", findings: 0 }] })
  })

  test("unknown shape: lenses null", () => {
    expect(parseReviewState(null)).toEqual({ lenses: null })
    expect(parseReviewState({ schema: "otro", state: {} })).toEqual({ lenses: null })
    const j = fixture("review-state-sample-app-r1.json")
    j.state.admitted_role_results[0].value = "basura"
    expect(parseReviewState(j)).toEqual({ riskLevel: "high", lenses: null })
    const k = fixture("review-state-sample-app-r1.json")
    delete k.state.selected_lenses
    expect(parseReviewState(k).lenses).toBeNull()
  })
})

describe("parseIntegration (v2)", () => {
  test("current_target stop: reason and step description", () => {
    expect(parseIntegration(fixture("review-sample-app-baseref-lineage-r1.json"))).toEqual({
      applies: "current",
      stop: {
        kind: "stop",
        reasonCode: "captured_artifacts_unverifiable",
        description: "Captured artifacts failed verification or are missing",
      },
    })
  })

  test("current_target asking for data (collect)", () => {
    expect(parseIntegration(fixture("review-sample-app-baseref-lineage-orig.json"))).toEqual({
      applies: "current",
      stop: { kind: "collect", reasonCode: "recovery_authorization_required", description: "recovery authorization required" },
    })
  })

  test("unrelated: from another code state, no stop and no command", () => {
    const j = fixture("review-sample-app-lineage.json")
    const parsed = parseIntegration(j)
    expect(parsed).toEqual({ applies: "other" })
    expect(JSON.stringify(parsed)).not.toMatch(/review start|--consent|command|arguments/)
  })

  test("an execute on the current code never copies the command", () => {
    const j = fixture("review-sample-app-lineage.json")
    j.applicability = "current_target"
    j.next_transition.invocation = "gentle-ai review start --consent=relay"
    const parsed = parseIntegration(j)
    expect(parsed).toEqual({
      applies: "current",
      stop: { kind: "execute", reasonCode: "fresh_target_ready", description: "Target is unreviewed and ready for initial review start" },
    })
    expect(JSON.stringify(parsed)).not.toMatch(/--consent|gentle-ai review|--cwd|--target/)
    expect(Object.keys(parsed.stop!).sort()).toEqual(["description", "kind", "reasonCode"])
  })

  test("another contract or garbage: unknown", () => {
    expect(parseIntegration({ ...fixture("review-sample-app-baseref-lineage-r1.json"), contract: "x/v1" })).toEqual({ applies: "unknown" })
    expect(parseIntegration("basura")).toEqual({ applies: "unknown" })
  })
})

// ── Loader ──────────────────────────────────────────────────────────────────

function repo(name: string): { root: string; entryPath: string } {
  const root = join(tmp, name)
  const entryPath = join(root, ".git", "gentle-ai", "review-transactions", "v2", "review-ff3e92437e221e59-r1")
  mkdirSync(entryPath, { recursive: true })
  writeFileSync(join(entryPath, "review-state.json"), raw("review-state-sample-app-r1.json"))
  return { root, entryPath }
}

/** Fake `run` that counts calls; v1 with the sample-app paths moved to `root`. */
function fakeRun(root: string, v1 = raw("review-sample-app.json").split(SAMPLE_APP).join(root)) {
  const calls: string[][] = []
  const state = { v1 }
  const run: Run = async (cmd, args) => {
    expect(cmd).toBe("gentle-ai")
    calls.push(args)
    if (args.length === 4) return state.v1
    return raw("review-sample-app-baseref-lineage-r1.json")
  }
  return { run, calls, state }
}

describe("createReviewLoader", () => {
  test("without .git: unavailable and review status is not run (it would git init)", async () => {
    const root = join(tmp, "nogit")
    mkdirSync(root, { recursive: true })
    let called = 0
    const run: Run = async () => (called++, raw("review-venue-finder.json"))
    expect(await createReviewLoader().load(root, run)).toEqual({ kind: "unavailable", reason: "sin git" })
    expect(called).toBe(0)
  })

  test("clean repo: none", async () => {
    const { root } = repo("clean")
    const { run, calls } = fakeRun("", raw("review-venue-finder.json"))
    expect(await createReviewLoader().load(root, run)).toEqual({ kind: "none" })
    expect(calls).toEqual([reviewStatusArgs(root)])
  })

  test("correction_required with lenses, risk and the current stop", async () => {
    const { root } = repo("alk")
    const { run, calls } = fakeRun(root)
    const r = await createReviewLoader().load(root, run)
    expect(r).toEqual({
      kind: "review",
      lineageId: "review-ff3e92437e221e59-r1",
      state: "correction_required",
      entryStatus: "recovered",
      riskLevel: "high",
      lenses: [
        { lens: "risk", status: "findings", findings: 3 },
        { lens: "resilience", status: "findings", findings: 2 },
        { lens: "readability", status: "findings", findings: 4 },
        { lens: "reliability", status: "findings", findings: 1 },
      ],
      applies: "current",
      stop: { kind: "stop", reasonCode: "captured_artifacts_unverifiable", description: "Captured artifacts failed verification or are missing" },
    } satisfies ReviewState)
    expect(calls).toEqual([reviewStatusArgs(root), reviewLineageArgs(root, "review-ff3e92437e221e59-r1")])
  })

  test("v2 memoized by lineage and revision", async () => {
    const { root } = repo("memo")
    const { run, calls, state } = fakeRun(root)
    const loader = createReviewLoader()
    await loader.load(root, run)
    await loader.load(root, run)
    expect(calls.filter((a) => a.length > 4)).toHaveLength(1)
    state.v1 = state.v1.replace("sha256:a6c2aa89", "sha256:ffffffff")
    await loader.load(root, run)
    expect(calls.filter((a) => a.length > 4)).toHaveLength(2)
    expect(calls.filter((a) => a.length === 4)).toHaveLength(3)
  })

  test("entry outside <root>/.git: review-state.json is not read", async () => {
    const { root } = repo("outside")
    const elsewhere = join(tmp, "ajeno", ".git", "gentle-ai", "review-transactions", "v2", "review-ff3e92437e221e59-r1")
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, "review-state.json"), raw("review-state-sample-app-r1.json"))
    const { run } = fakeRun("", raw("review-sample-app.json").split(SAMPLE_APP).join(join(tmp, "ajeno")))
    const r = await createReviewLoader().load(root, run)
    expect(r.kind === "review" && r.lenses).toBeNull()
    expect(r.kind === "review" && r.riskLevel).toBeUndefined()
  })

  test("unreadable review-state.json: lenses null, the rest goes on", async () => {
    const { root, entryPath } = repo("garbage")
    writeFileSync(join(entryPath, "review-state.json"), "{ no es json")
    const { run } = fakeRun(root)
    const r = await createReviewLoader().load(root, run)
    expect(r.kind === "review" && r.lenses).toBeNull()
    expect(r.kind === "review" && r.applies).toBe("current")
  })

  test("if v2 fails: applies unknown and it is retried next time", async () => {
    const { root } = repo("v2fail")
    let v2 = 0
    const run: Run = async (_c, args) => {
      if (args.length === 4) return raw("review-sample-app.json").split(SAMPLE_APP).join(root)
      v2++
      throw new Error("timeout")
    }
    const loader = createReviewLoader()
    const r = await loader.load(root, run)
    expect(r.kind === "review" && r.applies).toBe("unknown")
    await loader.load(root, run)
    expect(v2).toBe(2)
  })

  test(".git as a file (worktree) counts as a repo", async () => {
    const root = join(tmp, "worktree")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, ".git"), "gitdir: /otro/sitio\n")
    const { run, calls } = fakeRun("", raw("review-venue-finder.json"))
    expect(await createReviewLoader().load(root, run)).toEqual({ kind: "none" })
    expect(calls).toHaveLength(1)
  })

  test("if v1 fails, it throws", async () => {
    const { root } = repo("v1fail")
    const run: Run = async () => {
      throw new Error("exit 1")
    }
    await expect(createReviewLoader().load(root, run)).rejects.toThrow("exit 1")
  })
})
