// Activity of the open session, from what OpenCode already knows (read-only):
// `api.state.session.status(id)` (idle | busy | retry) and the pending questions
// and permissions. This only maps it and remembers since when it works; no IO.
import type { SessionActivity } from "../model.ts"

/** What is read from OpenCode for one session. */
export type SessionSignals = {
  /** `SessionStatus["type"]` from `@opencode-ai/sdk/v2`; `undefined` if OpenCode does not know yet. */
  status?: "idle" | "busy" | "retry"
  questions: number
  permissions: number
}

/** A pending question or permission wins: the agent is waiting for your answer. */
export function activityOf(signals: SessionSignals, since?: number): SessionActivity {
  const busy = signals.status === "busy" || signals.status === "retry"
  const withSince = busy && since !== undefined ? { since } : {}
  if (signals.questions > 0 || signals.permissions > 0) return { state: "waiting", ...withSince }
  if (busy) return { state: "busy", ...withSince }
  return { state: "idle" }
}

export function sameActivity(a: SessionActivity | undefined, b: SessionActivity | undefined): boolean {
  return a?.state === b?.state && a?.since === b?.since
}

/**
 * Remembers since when each session works: `since` is set when it turns busy (or
 * retry) and forgotten when it stops. Switching session starts from scratch.
 */
export function createActivityTracker() {
  let session: string | undefined
  let busySince: number | undefined
  return {
    /** No session (home screen): no activity. */
    update(sessionID: string | undefined, signals: SessionSignals | undefined, now: number): SessionActivity | undefined {
      if (sessionID !== session) {
        session = sessionID
        busySince = undefined
      }
      if (!sessionID || !signals) return undefined
      const busy = signals.status === "busy" || signals.status === "retry"
      if (!busy) busySince = undefined
      else busySince ??= now
      return activityOf(signals, busySince)
    },
  }
}
