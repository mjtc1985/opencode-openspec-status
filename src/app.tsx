/** @jsxImportSource @opentui/solid */
// The plugin itself, independent of the OpenCode version. The poller
// (`runtime/poller.ts`) produces the `Snapshot`, `view/` turns it into lines of
// segments and here each segment gets a theme color. It provides the sidebar, the
// indicator next to the prompt and the `openspec-status` route (full screen); each
// adapter (`tui.tsx` for OpenCode 1, `opencode-2.tsx` for OpenCode 2) registers them
// with its host API through `Host`. The route has two views: the interactive SDD
// detail (↑↓ change, ←→ phase, PgUp/PgDn scroll, enter pins the change for the
// sidebar) and the overview with the ODD feature list (↑↓ feature, enter pins it)
// and the diagrams; both load only while the route is open and tab switches between
// them. Each view has its key bar at the bottom. The pin (an SDD change or an ODD
// feature: the sidebar's focus) is the only thing the plugin writes, and it goes to
// the host's own storage, never to gentle-ai or the project. Besides Enter, the
// plugin itself writes it when a new SDD change or ODD feature is started in the
// session (`runtime/new-work.ts`). From the open session it only reads whether the
// agent works, stopped or is asking you (`runtime/activity.ts`), for the phase in
// progress and the clock.
import { realpath } from "node:fs/promises"
import type { RGBA } from "@opentui/core"
import { For, Show, createSignal, onCleanup, untrack, type JSX } from "solid-js"
import { type MessageKey, t } from "./i18n.ts"
import type { ColorKey, Line, SessionActivity, Snapshot } from "./model.ts"
import { createActivityTracker, sameActivity, type SessionSignals } from "./runtime/activity.ts"
import { createDetailLoader } from "./runtime/detail.ts"
import { createNewWorkPinner } from "./runtime/new-work.ts"
import { createPoller, emptySnapshot } from "./runtime/poller.ts"
import { createRun } from "./runtime/run.ts"
import { type Pin, activePin, isNewPin, parsePin, pinKey, togglePin } from "./sources/choice.ts"
import { type OddListModel, createOddListLoader } from "./sources/odd.ts"
import { compactLabel } from "./view/compact.ts"
import { type DetailKey, type DetailState, clampDetailState, initialDetailState, reduceDetail } from "./view/detail-state.ts"
import { buildView, detailLive } from "./view/flow-view.ts"
import { renderFull } from "./view/full.ts"
import { followOddSelection, type OddListView, reduceOddList } from "./view/odd-list.ts"
import { helpBar, type HelpItem } from "./view/parts.ts"
import { type DetailModel, panelScroll, renderSddDetail } from "./view/sdd-detail.ts"
import { renderSidebar } from "./view/sidebar.ts"

export const ID = "opencode-openspec-status"
export const ROUTE = "openspec-status"
/** How often to repaint so «N s ago» moves even when nothing changes. */
const AGE_TICK_MS = 5_000
/** How often the session is checked (and, while the agent works, the clock repainted). */
const ACTIVITY_TICK_MS = 1_000
/** How often the SDD detail is reread while the route is open. */
const DETAIL_TICK_MS = 3_000
// The sidebar is 42 columns wide, but the margin and scrollbar leave about 36
// usable (measured in the real 1.18.33 TUI): rows of 37-38 do not fit.
const SIDEBAR_RENDER_WIDTH = 36
const PIN_GRACE_MS = 1_000

/** Where the TUI is, as far as the plugin cares. */
export type Place = { kind: "home" } | { kind: "session"; sessionID: string } | { kind: "own" } | { kind: "other" }

/** What the plugin needs from the OpenCode TUI. `R` is the host's own route value. */
export interface Host<R> {
  readonly root: string
  /** The current route, as the host describes it. */
  route(): R
  place(route: R): Place
  /** Shows the `openspec-status` route. */
  navigateOwn(): void
  /** Goes back to `route`, or to the home screen. */
  navigateTo(route: R | undefined): void
  /** Durable per-key JSON storage for the pin. */
  readPin(key: string): unknown
  writePin(key: string, value: Pin | null): void
  /** State of a session; `undefined` if the host knows nothing about it. */
  session(sessionID: string): SessionSignals | undefined
  color(key: ColorKey): RGBA | string
  readonly renderer: {
    readonly width: number
    readonly height: number
    on(event: "resize", handler: () => void): unknown
    off(event: "resize", handler: () => void): unknown
  }
}

/** A key of the route: `run` returns false to let the key through. */
export interface RouteKey {
  readonly key: string
  readonly desc: MessageKey
  readonly run: () => boolean
}

export interface App {
  readonly Sidebar: () => JSX.Element
  readonly Compact: () => JSX.Element
  readonly Route: () => JSX.Element
  /** Opens the full screen (the `/openspec-status` command). */
  open(): void
  /** Esc on the full screen: back to where it was opened from. */
  back(): void
  /** Whether the full screen is the current route. */
  onRoute(): boolean
  /** Route keys, active only while `onRoute()`. */
  readonly keys: readonly RouteKey[]
  dispose(): void
}

export async function createApp<R>(host: Host<R>): Promise<App> {
  const root = host.root
  const [snapshot, setSnapshot] = createSignal<Snapshot>(emptySnapshot(root))
  const run = createRun()
  // The pin, `{ kind, name, branch }` in the host's storage, is per session: a new
  // session starts by choosing by branch or the most recent, and what you pin is
  // valid for it (also when reopened).
  const realRoot = await realpath(root).catch(() => root)
  let previous: R | undefined // route /openspec-status was opened from
  const onRoute = () => host.place(host.route()).kind === "own"
  const sessionOf = (r: R | undefined) => {
    if (r === undefined) return undefined
    const p = host.place(r)
    return p.kind === "session" ? p.sessionID : undefined
  }
  const currentSession = () => (onRoute() ? sessionOf(previous) : sessionOf(host.route()))
  const pinKeyNow = () => {
    const session = currentSession()
    return session ? pinKey(realRoot, session) : undefined
  }
  const storedPin = () => {
    const key = pinKeyNow()
    return key ? parsePin(host.readPin(key)) : undefined
  }
  // An SDD change or ODD feature the session had never seen gets pinned for it
  // (`origin: "new"`). What each session saw lives in memory, not in storage.
  const onListed = createNewWorkPinner({ root, session: currentSession, write: (session, next) => host.writePin(pinKey(realRoot, session), next ?? null) })
  const poller = createPoller({ root, run, pin: storedPin, onListed, onChange: (s) => setSnapshot(s) })
  void poller.refresh()

  // Activity of the open session: state (idle | busy | retry) and pending questions
  // or permissions. Without a session, nothing.
  const tracker = createActivityTracker()
  // If the host knows nothing about the session (or fails), no activity.
  const signalsOf = (session: string): SessionSignals | undefined => {
    try {
      return host.session(session)
    } catch {
      return undefined
    }
  }
  const readActivity = (at: number) => {
    const session = currentSession()
    return tracker.update(session, session ? signalsOf(session) : undefined, at)
  }
  const [activity, setActivity] = createSignal<SessionActivity | undefined>(readActivity(Date.now()), { equals: sameActivity })
  const [now, setNow] = createSignal(Date.now())
  // A single 1 s timer: always checks the session and repaints every second while
  // the agent works (the clock), and every 5 s otherwise (the ages).
  let lastPaint = Date.now()
  const ageTimer = setInterval(() => {
    const at = Date.now()
    const current = readActivity(at)
    setActivity(current)
    if (current?.state === "busy" || at - lastPaint >= AGE_TICK_MS) {
      lastPaint = at
      setNow(at)
    }
  }, ACTIVITY_TICK_MS)
  const view = () => {
    const a = activity()
    return buildView(snapshot(), now(), a ? { activity: a } : {})
  }

  // One row per line and one <text> per segment: <span> has no typed `fg`.
  // flexShrink 0: when the row does not fit, opentui shrinks the first whitespace
  // segment and the line shifts one column.
  const Row = (props: { line: Line }) => (
    <box flexDirection="row">
      <Show when={props.line.length > 0} fallback={<text> </text>}>
        <For each={props.line}>
          {(s) => (
            <text fg={host.color(s.color)} wrapMode="none" flexShrink={0}>
              {s.bold ? <b>{s.text}</b> : s.text}
            </text>
          )}
        </For>
      </Show>
    </box>
  )

  const Lines = (props: { lines: Line[] }) => (
    <box gap={0}>
      <For each={props.lines}>{(line) => <Row line={line} />}</For>
    </box>
  )

  const Sidebar = () => <Lines lines={renderSidebar(view(), SIDEBAR_RENDER_WIDTH)} />
  const Compact = () => <Show when={compactLabel(view())}>{(line) => <Row line={line()} />}</Show>

  // ── Full screen ───────────────────────────────────────────────────────────

  const [columns, setColumns] = createSignal(host.renderer.width)
  const [rows, setRows] = createSignal(host.renderer.height)
  const onResize = () => {
    setColumns(host.renderer.width)
    setRows(host.renderer.height)
  }
  host.renderer.on("resize", onResize)

  // Margin for the scrollbox scrollbar.
  const fullWidth = () => Math.max(40, columns() - 2)

  // ── SDD detail ────────────────────────────────────────────────────────────

  const detailLoader = createDetailLoader({ root, run })
  const [detail, setDetail] = createSignal<DetailModel>({ changes: [], loading: true })
  const [detailState, setDetailState] = createSignal<DetailState>(initialDetailState([]))
  /** View chosen with tab; `undefined` = the default one. */
  const [chosen, setChosen] = createSignal<"sdd" | "general" | undefined>()

  /** The model with the pin, if it belongs to this branch and the change is still active. */
  const detailView = (): DetailModel => {
    const model = detail()
    const pinned = activePin(
      storedPin(),
      "sdd",
      model.branch,
      model.changes.map((c) => c.status.name),
    )
    const live = detailLive(view())
    const withLive = live ? { ...model, live } : model
    return pinned ? { ...withLive, pinned, ...(isNewPin(storedPin()) ? { pinnedNew: true } : {}) } : withLive
  }

  // ── ODD feature list (overview) ───────────────────────────────────────────

  const oddListLoader = createOddListLoader({ root })
  const [oddList, setOddList] = createSignal<OddListModel>({ features: [], loading: true })
  const [oddSelected, setOddSelected] = createSignal(0)
  const oddListView = (): OddListView => {
    const list = oddList()
    const pinned = activePin(
      storedPin(),
      "odd",
      list.branch,
      list.features.map((f) => f.name),
    )
    if (!pinned) return { features: list.features, selected: oddSelected() }
    return { features: list.features, selected: oddSelected(), pinned, ...(isNewPin(storedPin()) ? { pinnedNew: true } : {}) }
  }
  const loadOddList = async () => {
    const model = await oddListLoader.load()
    if (disposed) return
    const before = untrack(oddList)
    setOddList(model)
    // First load: start on the pinned one, if any; afterwards follow it by name.
    if (before.loading) {
      const pinned = activePin(
        storedPin(),
        "odd",
        model.branch,
        model.features.map((f) => f.name),
      )
      setOddSelected(Math.max(0, model.features.findIndex((f) => f.name === pinned)))
    } else setOddSelected((i) => followOddSelection(i, before.features, model.features))
  }

  const sddAvailable = () => snapshot().sdd.value.kind === "change" || detail().changes.length > 0
  const fullView = (): "sdd" | "general" => (sddAvailable() ? (chosen() ?? "sdd") : "general")

  let detailTimer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  /** The next detail load is the one that opens `/openspec-status`. */
  let freshOpen = true
  const loadDetail = async () => {
    const model = await detailLoader.load(untrack(snapshot).sdd.value)
    if (disposed) return
    const before = untrack(detail).changes
    setDetail(model)
    const opening = freshOpen && model.changes.length > 0
    if (opening) freshOpen = false
    setDetailState((s) => {
      // On open: the change the sidebar shows (pinned, branch or recent), at its current phase.
      if (before.length === 0 || opening) {
        const sdd = untrack(snapshot).sdd.value
        const name = sdd.kind === "change" ? sdd.name : undefined
        return initialDetailState(model.changes, model.changes.findIndex((c) => c.status.name === name))
      }
      // Changes are sorted by date: follow the selected one by name.
      const name = before[s.changeIndex]?.status.name
      const at = model.changes.findIndex((c) => c.status.name === name)
      return clampDetailState(at >= 0 && at !== s.changeIndex ? { ...s, changeIndex: at } : s, model.changes)
    })
  }
  const stopDetail = () => {
    if (detailTimer !== undefined) clearInterval(detailTimer)
    detailTimer = undefined
  }
  const startDetail = () => {
    if (detailTimer !== undefined || disposed) return
    void loadDetail()
    void loadOddList()
    detailTimer = setInterval(() => {
      // If the route was left without unmounting, the timer stops itself.
      if (!onRoute()) return stopDetail()
      void loadDetail()
      void loadOddList()
    }, DETAIL_TICK_MS)
  }

  /**
   * Overview key bar: ↑↓ pick a feature when there are several (otherwise they
   * scroll), enter pins when there is one and tab only when there is an SDD detail.
   */
  const generalHelp = (): Line => {
    const n = oddList().features.length
    const items: HelpItem[] = [n > 1 ? ["↑↓", t("help.feature")] : ["↑↓", t("help.scroll")]]
    if (n > 0 && currentSession()) items.push(["enter", t("help.pin")])
    if (sddAvailable()) items.push(["tab", t("help.detail")])
    items.push(["esc", t("help.back")])
    return helpBar(items, fullWidth())
  }
  /** The detail takes the whole route: its key bar is its last line. */
  const detailHeight = () => Math.max(1, rows())

  const Route = () => {
    untrack(startDetail)
    onCleanup(stopDetail)
    return (
      <box flexDirection="column" flexGrow={1}>
        <Show
          when={fullView() === "sdd"}
          fallback={
            <>
              <scrollbox flexGrow={1} scrollY={true} focused={true}>
                <Lines lines={renderFull(view(), fullWidth(), { oddList: oddListView() })} />
              </scrollbox>
              <Row line={generalHelp()} />
            </>
          }
        >
          {/* Outside the scrollbox: keys reach the key layer and the render cuts itself. */}
          <box flexGrow={1}>
            <Lines lines={renderSddDetail(detailView(), detailState(), fullWidth(), { height: detailHeight(), canPin: currentSession() !== undefined })} />
          </box>
        </Show>
      </box>
    )
  }

  let openedAt = 0
  const open = () => {
    openedAt = Date.now()
    if (!onRoute()) {
      previous = host.route()
      setChosen(undefined)
      freshOpen = true
    }
    void poller.refresh()
    host.navigateOwn()
    // In case the route did not unmount when left and the timer stopped itself.
    startDetail()
  }
  const back = () => {
    const to = previous
    previous = undefined
    host.navigateTo(to)
  }

  // Detail keys, only on the route. Returning false lets the key through (in the
  // overview, PgUp/PgDn, and ↑↓ without several features, keep scrolling the
  // scrollbox). PgUp/PgDn need the panel measurements as currently drawn. `[` `]`
  // remain aliases of ↑↓, without a place in the bar.
  const move = (key: DetailKey) => () => {
    if (fullView() !== "sdd") return false
    setDetailState((s) => reduceDetail(s, key, detail().changes, panelScroll(detailView(), s, fullWidth(), detailHeight())))
    return true
  }
  // ↑↓: in the detail, the change list; in the overview, the ODD feature list when
  // there are several (otherwise the key goes on to the scrollbox).
  const upDown = (key: "up" | "down") => () => {
    if (fullView() === "sdd") return move(key === "up" ? "prevChange" : "nextChange")()
    const n = oddList().features.length
    if (n <= 1) return false
    setOddSelected((i) => reduceOddList(i, key, n))
    return true
  }
  // Enter pins the selected change (detail) or feature (overview) for the sidebar,
  // replacing whatever was pinned; on what is already pinned, it releases it.
  const pin = () => {
    const general = fullView() !== "sdd"
    if (general && oddList().features.length === 0) return false
    // The Enter that opens /openspec-status (or a repeated one) already reaches this
    // route: without this margin it pinned the first change right away.
    if (Date.now() - openedAt < PIN_GRACE_MS) return true
    let next
    if (general) {
      const list = oddList()
      const name = list.features[Math.min(oddSelected(), list.features.length - 1)]?.name
      if (!name) return true
      next = togglePin(storedPin(), "odd", name, list.branch)
    } else {
      const model = detail()
      const name = model.changes[clampDetailState(detailState(), model.changes).changeIndex]?.status.name
      if (!name) return true
      next = togglePin(storedPin(), "sdd", name, model.branch)
    }
    // Releasing stores `null` (`parsePin(null)` means «not pinned»): it does not
    // depend on whether the storage deletes the key on `undefined`. Pinning by hand
    // also replaces an automatic pin (and something new later replaces a manual one).
    const key = pinKeyNow()
    if (!key) return true // opened from the home screen: no session to pin for
    host.writePin(key, next ?? null)
    void poller.refresh()
    return true
  }
  const toggle = () => {
    if (!sddAvailable()) return false
    setChosen(fullView() === "sdd" ? "general" : "sdd")
    return true
  }
  const keys: RouteKey[] = [
    { key: "up", desc: "key.prevItem", run: upDown("up") },
    { key: "down", desc: "key.nextItem", run: upDown("down") },
    { key: "pageup", desc: "key.pageUp", run: move("pageUp") },
    { key: "pagedown", desc: "key.pageDown", run: move("pageDown") },
    { key: "[", desc: "key.prevChange", run: move("prevChange") },
    { key: "]", desc: "key.nextChange", run: move("nextChange") },
    { key: "left", desc: "key.prevPhase", run: move("left") },
    { key: "right", desc: "key.nextPhase", run: move("right") },
    { key: "home", desc: "key.firstPhase", run: move("home") },
    { key: "end", desc: "key.lastPhase", run: move("end") },
    { key: "return", desc: "key.pin", run: pin },
    { key: "tab", desc: "key.toggle", run: toggle },
  ]

  const dispose = () => {
    disposed = true
    stopDetail()
    detailLoader.dispose()
    oddListLoader.dispose()
    poller.dispose()
    clearInterval(ageTimer)
    host.renderer.off("resize", onResize)
  }

  return { Sidebar, Compact, Route, open, back, onRoute, keys, dispose }
}
