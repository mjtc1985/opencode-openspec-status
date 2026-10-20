/** @jsxImportSource @opentui/solid */
// OpenCode TUI plugin: it only draws. The poller (`runtime/poller.ts`) produces the
// `Snapshot`, `view/` turns it into lines of segments and here each segment gets a
// theme color. It registers the sidebar, the indicator next to the prompt, the
// `openspec-status` route (full screen) and the `/openspec-status` command. The
// route has two views: the interactive SDD detail (↑↓ change, ←→ phase, PgUp/PgDn
// scroll, enter pins the change for the sidebar) and the overview with the ODD
// feature list (↑↓ feature, enter pins it) and the diagrams; both load only while
// the route is open and tab switches between them. Each view has its key bar at the
// bottom. The pin (an SDD change or an ODD feature: the sidebar's focus) is the only
// thing the plugin writes, and it goes to OpenCode's KV (`api.kv`), never to
// gentle-ai or the project. Besides Enter, the plugin itself writes it when a new
// SDD change or ODD feature is started in the session (`runtime/new-work.ts`). From
// the open session it only reads whether the agent works, stopped or is asking you
// (`runtime/activity.ts`), for the phase in progress and the clock.
import { realpath } from "node:fs/promises"
import type { TuiPlugin, TuiPluginModule, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { For, Show, createSignal, onCleanup, untrack } from "solid-js"
import { t } from "./i18n.ts"
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

const ID = "opencode-openspec-status"
const ROUTE = "openspec-status"
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

const tui: TuiPlugin = async (api) => {
  const root = api.state.path.directory || process.cwd()
  const [snapshot, setSnapshot] = createSignal<Snapshot>(emptySnapshot(root))
  const run = createRun()
  // The pin, `{ kind, name, branch }` in OpenCode's KV, is per session: a new
  // session starts by choosing by branch or the most recent, and what you pin is
  // valid for it (also when reopened).
  const realRoot = await realpath(root).catch(() => root)
  let previous: TuiRouteCurrent | undefined // route /openspec-status was opened from
  const sessionOf = (r: TuiRouteCurrent | undefined) =>
    r?.name === "session" && typeof r.params?.sessionID === "string" ? r.params.sessionID : undefined
  const currentSession = () => (api.route.current.name === ROUTE ? sessionOf(previous) : sessionOf(api.route.current))
  const pinKeyNow = () => {
    const session = currentSession()
    return session ? pinKey(realRoot, session) : undefined
  }
  const storedPin = () => {
    const key = pinKeyNow()
    return key ? parsePin(api.kv.get<unknown>(key)) : undefined
  }
  // The KV is a Solid store that merges objects (a stale `change` used to remain next
  // to `kind`/`name`): first `null`, then the new value, to replace it as a whole.
  const writePin = (key: string, next: Pin | undefined) => {
    api.kv.set(key, null)
    if (next) api.kv.set(key, next)
  }
  // An SDD change or ODD feature the session had never seen gets pinned for it
  // (`origin: "new"`). What each session saw lives in memory, not in the KV.
  const onListed = createNewWorkPinner({ root, session: currentSession, write: (session, next) => writePin(pinKey(realRoot, session), next) })
  const poller = createPoller({ root, run, pin: storedPin, onListed, onChange: (s) => setSnapshot(s) })
  void poller.refresh()

  // Activity of the open session: state (idle | busy | retry) and pending questions
  // or permissions, from `api.state.session`. Without a session, nothing.
  const tracker = createActivityTracker()
  // If OpenCode knows nothing about the session (or fails), no activity.
  const signalsOf = (session: string): SessionSignals | undefined => {
    try {
      return {
        status: api.state.session.status(session)?.type,
        questions: api.state.session.question(session)?.length ?? 0,
        permissions: api.state.session.permission(session)?.length ?? 0,
      }
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

  const paint = (key: ColorKey) => {
    const theme = api.theme.current
    switch (key) {
      case "text":
        return theme.text
      case "muted":
        return theme.textMuted
      case "accent":
        return theme.primary
      case "success":
        return theme.success
      case "warning":
        return theme.warning
      case "error":
        return theme.error
    }
  }

  // One row per line and one <text> per segment: <span> has no typed `fg`.
  // flexShrink 0: when the row does not fit, opentui shrinks the first whitespace
  // segment and the line shifts one column.
  const Row = (props: { line: Line }) => (
    <box flexDirection="row">
      <Show when={props.line.length > 0} fallback={<text> </text>}>
        <For each={props.line}>
          {(s) => (
            <text fg={paint(s.color)} wrapMode="none" flexShrink={0}>
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

  const Compact = () => <Show when={compactLabel(view())}>{(line) => <Row line={line()} />}</Show>

  api.slots.register({
    order: 130,
    slots: {
      sidebar_content: () => <Lines lines={renderSidebar(view(), SIDEBAR_RENDER_WIDTH)} />,
      session_prompt_right: () => <Compact />,
    },
  })

  // ── Full screen ───────────────────────────────────────────────────────────

  const [columns, setColumns] = createSignal(api.renderer.width)
  const [rows, setRows] = createSignal(api.renderer.height)
  const onResize = () => {
    setColumns(api.renderer.width)
    setRows(api.renderer.height)
  }
  api.renderer.on("resize", onResize)

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
      if (api.route.current.name !== ROUTE) return stopDetail()
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

  const DetailRoute = () => {
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

  const disposeRoute = api.route.register([{ name: ROUTE, render: () => <DetailRoute /> }])

  let openedAt = 0
  const open = () => {
    openedAt = Date.now()
    if (api.route.current.name !== ROUTE) {
      previous = api.route.current
      setChosen(undefined)
      freshOpen = true
    }
    void poller.refresh()
    api.route.navigate(ROUTE)
    // In case the route did not unmount when left and the timer stopped itself.
    startDetail()
  }
  const back = () => {
    const to = previous ?? { name: "home" }
    previous = undefined
    api.route.navigate(to.name, "params" in to ? (to.params as Record<string, unknown> | undefined) : undefined)
  }

  // Same shape as OpenCode 1.18's own commands: `namespace: "palette"` puts it in the
  // palette and `slashName` offers it as `/openspec-status`.
  const disposeCommands = api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "openspec-status.show",
        title: t("command.title"),
        desc: t("command.desc"),
        category: "openspec-status",
        slashName: ROUTE,
        run: open,
      },
    ],
  })
  // Esc goes back to the previous route, only while the full screen is shown.
  const disposeBack = api.keymap.registerLayer({
    enabled: () => api.route.current.name === ROUTE,
    bindings: [{ key: "escape", desc: t("help.back"), group: "openspec-status", cmd: back }],
  })

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
    // depend on whether the KV deletes the key on `undefined`. Pinning by hand also
    // replaces an automatic pin (and something new later replaces a manual one).
    const key = pinKeyNow()
    if (!key) return true // opened from the home screen: no session to pin for
    writePin(key, next)
    void poller.refresh()
    return true
  }
  const toggle = () => {
    if (!sddAvailable()) return false
    setChosen(fullView() === "sdd" ? "general" : "sdd")
    return true
  }
  const disposeDetailKeys = api.keymap.registerLayer({
    enabled: () => api.route.current.name === ROUTE,
    bindings: [
      { key: "up", desc: t("key.prevItem"), group: "openspec-status", cmd: upDown("up") },
      { key: "down", desc: t("key.nextItem"), group: "openspec-status", cmd: upDown("down") },
      { key: "pageup", desc: t("key.pageUp"), group: "openspec-status", cmd: move("pageUp") },
      { key: "pagedown", desc: t("key.pageDown"), group: "openspec-status", cmd: move("pageDown") },
      { key: "[", desc: t("key.prevChange"), group: "openspec-status", cmd: move("prevChange") },
      { key: "]", desc: t("key.nextChange"), group: "openspec-status", cmd: move("nextChange") },
      { key: "left", desc: t("key.prevPhase"), group: "openspec-status", cmd: move("left") },
      { key: "right", desc: t("key.nextPhase"), group: "openspec-status", cmd: move("right") },
      { key: "home", desc: t("key.firstPhase"), group: "openspec-status", cmd: move("home") },
      { key: "end", desc: t("key.lastPhase"), group: "openspec-status", cmd: move("end") },
      { key: "return", desc: t("key.pin"), group: "openspec-status", cmd: pin },
      { key: "tab", desc: t("key.toggle"), group: "openspec-status", cmd: toggle },
    ],
  })

  api.lifecycle.onDispose(() => {
    disposed = true
    stopDetail()
    detailLoader.dispose()
    oddListLoader.dispose()
    disposeDetailKeys()
    poller.dispose()
    clearInterval(ageTimer)
    api.renderer.off("resize", onResize)
    disposeBack()
    disposeCommands()
    disposeRoute()
  })
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }
export default plugin
