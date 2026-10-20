/** @jsxImportSource @opentui/solid */
// OpenCode 2.x adapter (`@opencode/plugin/tui`): registers what `app.tsx` provides
// with the 2.x TUI API. The sidebar and the prompt indicator are claims on the
// `sidebar.content` and `prompt.footer.status` slots, the full screen is the
// `openspec-status` page opened with the `/openspec-status` command, and the pin
// is stored in the plugin's durable storage (`context.storage`). OpenCode 2 loads
// it through `tui.ts` at the package root (see there).
//
// Only types are imported from `@opencode/plugin`: `Plugin.define` is the identity,
// so this module has no runtime dependency on the host package.
import type { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { createApp, ID, ROUTE, type Host, type Place } from "./app.tsx"
import { t } from "./i18n.ts"
import type { Pin } from "./sources/choice.ts"

type Context = Plugin.Context
type Route = ReturnType<Context["ui"]["router"]["current"]>

async function setup(context: Context): Promise<Plugin.Cleanup> {
  const { data, ui } = context
  const place = (r: Route): Place => {
    if (r.type === "home") return { kind: "home" }
    if (r.type === "session") return { kind: "session", sessionID: r.sessionID }
    return r.name === ROUTE ? { kind: "own" } : { kind: "other" }
  }
  // One durable store for every pin, keyed like the 1.x KV keys.
  const [pins, setPins] = context.storage.store<Record<string, Pin | null>>("pins", { initial: {} })
  // Pending permissions and forms are only listed once synced: ask once per session.
  const synced = new Set<string>()
  const sync = (session: string) => {
    if (synced.has(session)) return
    synced.add(session)
    void data.session.permission.sync(session).catch(() => {})
    void data.session.form.sync(session).catch(() => {})
  }
  const host: Host<Route> = {
    root: context.location?.directory ?? data.location.default().directory ?? process.cwd(),
    // A copy: the router hands out a live store that changes when navigating.
    route: () => ({ ...ui.router.current() }),
    place,
    navigateOwn: () => ui.router.navigate({ type: "plugin", name: ROUTE }),
    navigateTo: (to) => ui.router.navigate(to ?? { type: "home" }),
    readPin: (key) => pins[key],
    writePin: (key, value) => {
      void setPins((draft) => {
        draft[key] = value
      })
    },
    session: (session) => {
      sync(session)
      return {
        status: data.session.status(session) === "running" ? "busy" : "idle",
        questions: data.session.form.list(session)?.length ?? 0,
        permissions: data.session.permission.list(session)?.length ?? 0,
      }
    },
    color: (key) => {
      const theme = context.theme
      switch (key) {
        case "text":
          return theme.text.base
        case "muted":
          return theme.text.muted
        case "accent":
          // What OpenCode's own 1.x → 2.x theme migration maps `primary` to.
          return theme.hue.interactive[200]
        case "success":
          return theme.text.feedback.success.base
        case "warning":
          return theme.text.feedback.warning.base
        case "error":
          return theme.text.feedback.error.base
      }
    },
    renderer: context.renderer,
  }
  const app = await createApp(host)

  const disposeSidebar = ui.slot({ append: "sidebar.content", render: () => <app.Sidebar /> })
  // Only inside a session, as in OpenCode 1 (the home screen prompt has none).
  const disposeIndicator = ui.slot({
    append: "prompt.footer.status",
    render: (input) => (
      <Show when={input.sessionID}>
        <app.Compact />
      </Show>
    ),
  })
  const disposeRoute = ui.router.register({ name: ROUTE, render: () => <app.Route /> })

  // Global: the slash completion runs while the prompt has its own input mode.
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "openspec-status.show",
        title: t("command.title"),
        description: t("command.desc"),
        group: "openspec-status",
        palette: true,
        slash: { name: ROUTE },
        run: app.open,
      },
    ],
  }))
  // Esc and the route keys, only while the full screen is shown. A key whose action
  // returns false goes on to the next layer (the overview's scrollbox).
  context.keymap.layer(() => ({
    enabled: app.onRoute,
    commands: [
      { title: t("help.back"), group: "openspec-status", bind: "escape", run: app.back },
      ...app.keys.map((k) => ({
        title: t(k.desc),
        group: "openspec-status",
        bind: k.key,
        run: () => (k.run() ? undefined : false),
      })),
    ],
  }))

  return () => {
    app.dispose()
    disposeRoute()
    disposeIndicator()
    disposeSidebar()
  }
}

const plugin: Plugin.Definition = { id: ID, setup }
export default plugin
