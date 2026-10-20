import { describe, expect, test } from "bun:test"
import { activityOf, createActivityTracker, sameActivity } from "../../src/runtime/activity.ts"

const none = { questions: 0, permissions: 0 }

describe("activityOf: OpenCode status → activity", () => {
  test("busy and retry are working; idle or no status, stopped", () => {
    expect(activityOf({ status: "busy", ...none }, 10)).toEqual({ state: "busy", since: 10 })
    expect(activityOf({ status: "retry", ...none }, 10)).toEqual({ state: "busy", since: 10 })
    expect(activityOf({ status: "idle", ...none }, 10)).toEqual({ state: "idle" })
    expect(activityOf({ ...none })).toEqual({ state: "idle" })
  })

  test("a pending question or permission wins: waiting", () => {
    expect(activityOf({ status: "busy", questions: 1, permissions: 0 }, 10)).toEqual({ state: "waiting", since: 10 })
    expect(activityOf({ status: "idle", questions: 0, permissions: 2 })).toEqual({ state: "waiting" })
  })

  test("sameActivity compares state and since", () => {
    expect(sameActivity({ state: "busy", since: 1 }, { state: "busy", since: 1 })).toBe(true)
    expect(sameActivity({ state: "busy", since: 1 }, { state: "busy", since: 2 })).toBe(false)
    expect(sameActivity(undefined, undefined)).toBe(true)
    expect(sameActivity(undefined, { state: "idle" })).toBe(false)
  })
})

describe("createActivityTracker: since when it has been working", () => {
  test("since is set on entering busy, kept through retry and dropped on stop", () => {
    const t = createActivityTracker()
    expect(t.update("A", { status: "idle", ...none }, 0)).toEqual({ state: "idle" })
    expect(t.update("A", { status: "busy", ...none }, 1_000)).toEqual({ state: "busy", since: 1_000 })
    expect(t.update("A", { status: "retry", ...none }, 5_000)).toEqual({ state: "busy", since: 1_000 })
    expect(t.update("A", { status: "busy", questions: 1, permissions: 0 }, 6_000)).toEqual({ state: "waiting", since: 1_000 })
    expect(t.update("A", { status: "idle", ...none }, 7_000)).toEqual({ state: "idle" })
    expect(t.update("A", { status: "busy", ...none }, 9_000)).toEqual({ state: "busy", since: 9_000 })
  })

  test("without a session (home screen) or data there is no activity; another session starts from scratch", () => {
    const t = createActivityTracker()
    expect(t.update(undefined, undefined, 0)).toBeUndefined()
    expect(t.update("A", undefined, 0)).toBeUndefined()
    t.update("A", { status: "busy", ...none }, 1_000)
    expect(t.update("B", { status: "busy", ...none }, 4_000)).toEqual({ state: "busy", since: 4_000 })
  })
})
