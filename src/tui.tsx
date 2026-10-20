/** @jsxImportSource @opentui/solid */
// OpenCode 1.x adapter (`@opencode-ai/plugin/tui`): registers what `app.tsx`
// provides with the 1.x TUI API. The sidebar and the prompt indicator go to the
// `sidebar_content` and `session_prompt_right` slots, the full screen is the
// `openspec-status` route opened with the `/openspec-status` command, and the pin is
// stored in OpenCode's KV (`api.kv`).
import type { TuiPlugin, TuiPluginModule, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { createApp, ID, ROUTE, type Host, type Place } from "./app.tsx"
import { t } from "./i18n.ts"

const tui: TuiPlugin = async (api) => {
  const place = (r: TuiRouteCurrent): Place => {
    if (r.name === ROUTE) return { kind: "own" }
    if (r.name === "home") return { kind: "home" }
    if (r.name === "session" && typeof r.params?.sessionID === "string") return { kind: "session", sessionID: r.params.sessionID }
    return { kind: "other" }
  }
  const host: Host<TuiRouteCurrent> = {
    root: api.state.path.directory || process.cwd(),
    route: () => api.route.current,
    place,
    navigateOwn: () => api.route.navigate(ROUTE),
    navigateTo: (to) => {
      const target = to ?? { name: "home" }
      api.route.navigate(target.name, "params" in target ? (target.params as Record<string, unknown> | undefined) : undefined)
    },
    readPin: (key) => api.kv.get<unknown>(key),
    // The KV is a Solid store that merges objects (a stale `change` used to remain
    // next to `kind`/`name`): first `null`, then the new value, to replace it whole.
    writePin: (key, value) => {
      api.kv.set(key, null)
      if (value) api.kv.set(key, value)
    },
    session: (session) => ({
      status: api.state.session.status(session)?.type,
      questions: api.state.session.question(session)?.length ?? 0,
      permissions: api.state.session.permission(session)?.length ?? 0,
    }),
    color: (key) => {
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
    },
    renderer: api.renderer,
  }
  const app = await createApp(host)

  api.slots.register({
    order: 130,
    slots: {
      sidebar_content: () => <app.Sidebar />,
      session_prompt_right: () => <app.Compact />,
    },
  })
  const disposeRoute = api.route.register([{ name: ROUTE, render: () => <app.Route /> }])

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
        run: app.open,
      },
    ],
  })
  // Esc goes back to the previous route, only while the full screen is shown.
  const disposeBack = api.keymap.registerLayer({
    enabled: app.onRoute,
    bindings: [{ key: "escape", desc: t("help.back"), group: "openspec-status", cmd: app.back }],
  })
  const disposeKeys = api.keymap.registerLayer({
    enabled: app.onRoute,
    bindings: app.keys.map((k) => ({ key: k.key, desc: t(k.desc), group: "openspec-status", cmd: k.run })),
  })

  api.lifecycle.onDispose(() => {
    app.dispose()
    disposeKeys()
    disposeBack()
    disposeCommands()
    disposeRoute()
  })
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }
export default plugin
