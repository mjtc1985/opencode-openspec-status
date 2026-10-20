import { describe, expect, test } from "bun:test"
import { SDD_PHASES, type Line, type SddPhaseId } from "../../src/model.ts"
import type { DetailState } from "../../src/view/detail-state.ts"
import { helpBar } from "../../src/view/parts.ts"
import { detailHelp, panelScroll, renderSddDetail, type DetailModel } from "../../src/view/sdd-detail.ts"
import { lineText, lineWidth } from "../../src/view/text.ts"
import { omDecimalsDetail, omDecimalsStatus, priceCacheDetail, priceCacheStatus, T_SPECS, T_TASKS, twoChanges } from "./detail-fixtures.ts"
import { segmentsWith, texts } from "./helpers.ts"

const at = (phase: SddPhaseId, changeIndex = 0, scroll?: number): DetailState => (scroll === undefined ? { changeIndex, phase } : { changeIndex, phase, scroll })
const render = (model: DetailModel, state: DetailState, width = 100, height?: number) =>
  renderSddDetail(model, state, width, height === undefined ? {} : { height })
const show = (model: DetailModel, state: DetailState, width = 100) => texts(render(model, state, width))
const joined = (model: DetailModel, state: DetailState, width = 100) => show(model, state, width).join("\n")

const HELP_100 = " ↑↓ cambio  ←→ fase  RePág/AvPág desplazar  enter fijar  tab vista general  esc volver"

/** Panel lines: what follows the last rule, without the key bar. */
function panel(lines: string[]): string[] {
  const last = lines.findLastIndex((l) => /^ ─+$/.test(l))
  return lines.slice(last + 1, -1)
}

const STALE = "⚠ specs cambiaron tras tasks"

describe("header, change list and phase strip", () => {
  test("two changes: the selected one with ▸ in accent, compact summary and work item", () => {
    const lines = render(twoChanges(), at("apply"))
    const t = texts(lines)
    expect(t[0]).toBe(" openspec-status · SDD")
    expect(t[2]).toMatch(/^ ▸ add-price-cache +apply 6\/16 ⚠ +AB#48213$/)
    expect(t[3]).toMatch(/^ {3}fix-om-decimals +spec ▸ design$/)
    const marker = lines[2]!.find((s) => s.text === "▸ ")!
    expect(marker.color).toBe("accent")
    expect(lines[2]!.find((s) => s.text === "add-price-cache")).toMatchObject({ color: "accent", bold: true })
    expect(lines[3]!.find((s) => s.text === "fix-om-decimals")!.color).toBe("text")
  })

  test("the selected row is bold in full; the others are not", () => {
    const lines = render(twoChanges(), at("apply"))
    expect(lines[2]!.find((s) => s.text === "apply 6/16")).toMatchObject({ bold: true })
    expect(lines[2]!.find((s) => s.text === "AB#48213")).toMatchObject({ color: "text", bold: true })
    expect(lines[3]!.filter((s) => s.text.trim() !== "").every((s) => !s.bold)).toBe(true)
    const second = render(twoChanges(), at("spec", 1))
    expect(second[2]!.find((s) => s.text === "AB#48213")).toMatchObject({ color: "muted" })
    expect(second[3]!.find((s) => s.text === "spec")).toMatchObject({ bold: true })
  })

  test("pinned as new: «nuevo» where «fijado» goes, with the work item aligned", () => {
    const t = texts(render({ ...twoChanges(), pinned: "add-price-cache", pinnedNew: true }, at("apply")))
    expect(t[2]).toMatch(/^ ▸ add-price-cache +apply 6\/16 ⚠ +nuevo +AB#48213$/)
    expect(t.some((l) => l.includes("fijado"))).toBe(false)
    const om = texts(render({ ...twoChanges(), pinned: "fix-om-decimals", pinnedNew: true }, at("apply")))
    expect(om[3]).toMatch(/^ {3}fix-om-decimals +spec ▸ design +nuevo$/)
    expect(om[2]!.indexOf("AB#48213")).toBe(om[3]!.indexOf("nuevo") + "nuevo".length + 3)
  })

  test("«fijado» next to the pinned row, before the work item and aligned", () => {
    const pinnedOm = render({ ...twoChanges(), pinned: "fix-om-decimals" }, at("apply"))
    const t = texts(pinnedOm)
    expect(t[3]).toMatch(/^ {3}fix-om-decimals +spec ▸ design +fijado$/)
    expect(t[2]).toMatch(/^ ▸ add-price-cache +apply 6\/16 ⚠ +AB#48213$/)
    expect(t[2]!.indexOf("AB#48213")).toBe(t[3]!.indexOf("fijado") + "fijado".length + 3)
    expect(pinnedOm[3]!.find((s) => s.text === "fijado")).toMatchObject({ color: "accent" })
    const pinnedPrice = texts(render({ ...twoChanges(), pinned: "add-price-cache" }, at("apply")))
    expect(pinnedPrice[2]).toMatch(/^ ▸ add-price-cache +apply 6\/16 ⚠ +fijado +AB#48213$/)
    expect(pinnedPrice[3]).toMatch(/^ {3}fix-om-decimals +spec ▸ design$/)
    // Without a pin the work item column does not move.
    expect(show(twoChanges(), at("apply"))[2]).toMatch(/^ ▸ add-price-cache +apply 6\/16 ⚠ {4}AB#48213$/)
  })

  test("selecting the second change moves the mark and the panel", () => {
    const t = show(twoChanges(), at("spec", 1))
    expect(t[2]).toStartWith("   add-price-cache")
    expect(t[3]).toStartWith(" ▸ fix-om-decimals")
    expect(panel(t)[0]).toBe("  spec · specs")
  })

  test("the selected phase goes in brackets and may differ from the current one (◉)", () => {
    const lines = render(twoChanges(), at("propose"), 120)
    const strip = texts(lines).find((l) => l.includes("explore"))!
    expect(strip).toBe("  ✓ explore ─[✓ propose]─ ✓ spec ─ ✓ design ─ ✓ tasks ─ ◉ apply ─ ○ verify ─ ○ archive")
    expect(segmentsWith(lines, "[✓ propose]")[0]).toMatchObject({ color: "accent", bold: true })
    expect(segmentsWith(lines, "◉")[0]!.color).toBe("accent")
  })

  test("the strip includes archive and splits into even rows when it does not fit", () => {
    const t = show(twoChanges(), at("archive"), 76)
    expect(t[5]).toBe("  ✓ explore ─ ✓ propose ─ ✓ spec ─ ✓ design ─")
    expect(t[6]).toBe("  ✓ tasks ─ ◉ apply ─ ○ verify ─[○ archive]")
    const narrow = show(twoChanges(), at("design"), 40)
    const strip = narrow.filter((l) => /[✓○◉\]] (explore|propose|spec|design|tasks|apply|verify|archive)|\[/.test(l))
    expect(strip.join(" ")).toContain("[✓ design]")
    expect(strip.join(" ")).toContain("archive")
  })

  test("many changes: window around the selected one and position", () => {
    const base = twoChanges().changes[1]!
    const changes = Array.from({ length: 9 }, (_, i) => ({ ...base, status: { ...base.status, name: `cambio-${i + 1}` } }))
    const t = show({ changes }, at("spec", 7))
    expect(t.some((l) => l.startsWith(" ▸ cambio-8"))).toBe(true)
    expect(t.some((l) => l.includes("cambio-1 "))).toBe(false)
    expect(t).toContain("   8 de 9")
  })
})

describe("panel per phase", () => {
  test("explore: no artifact of its own and what already exists", () => {
    const p = panel(show(twoChanges(), at("explore")))
    expect(p[0]).toBe("  explore · sin artefacto")
    expect(p.join(" ")).toContain("no deja artefacto propio")
    expect(p.join(" ")).toContain("ya hay: proposal, specs, design, tasks, apply-progress, verify-report")
  })

  test("propose: wrapped why, what changes with «… y N más», capabilities and work item with URL", () => {
    const p = panel(show(twoChanges(), at("propose"), 100))
    expect(p[0]).toBe("  propose · proposal.md")
    expect(p).toContain("   Por qué")
    expect(p[2]).toStartWith("     Cada consulta de precio llama al servicio de tarifas")
    expect(p).toContain("     · Caché en memoria de precios con clave por región y producto.")
    expect(p).toContain("     … y 2 más")
    expect(p).toContain("     + price-cache  nueva")
    expect(p).toContain("     ~ pricing-api  modificada")
    expect(p).toContain("   Work item")
    expect(p).toContain("     AB#48213 · desde .openspec.yaml")
    expect(p).toContain("     https://dev.azure.com/contoso/Tienda/_workitems/edit/48213")
  })

  test("propose without a work item: hint to add one", () => {
    const p = panel(show(twoChanges(), at("propose", 1)))
    expect(p.join(" ")).toContain("sin work item · añade workItem: AB#123 en .openspec.yaml")
    expect(p).toContain("     ~ order-units  modificada")
  })

  test("spec: requirements per capability with delta and scenarios", () => {
    const p = panel(show(twoChanges(), at("spec"), 100))
    expect(p[0]).toStartWith("  spec · 2 capacidades · 6 requisitos")
    expect(p).toContain("   price-cache  3 requisitos")
    expect(p.find((l) => l.includes("Clave de caché"))).toMatch(/^ {5}\+ Clave de caché por región y producto +2 esc\.$/)
    expect(p.find((l) => l.includes("Invalidación"))).toMatch(/3 esc\.$/)
    expect(p.find((l) => l.includes("Consulta de precio"))).toMatch(/^ {5}~ Consulta de precio +1 esc\.$/)
    expect(p).toContain("     - Consulta directa al servicio de tarifas")
    expect(p).toContain("     » Precio por región y producto")
  })

  test("design: numbered decisions and risks", () => {
    const p = panel(show(twoChanges(), at("design")))
    expect(p).toEqual([
      "  design · design.md",
      "   Decisiones",
      "     1. Caché en memoria por instancia",
      "     2. Clave compuesta región y producto",
      "     3. Invalidación por evento de censo",
      "   Riesgos",
      "     · Precios desfasados entre instancias → cada instancia tiene su caché. Mitigación: TTL corto p…",
      "     · Consumo de memoria → muchas regiones por muchos productos. Mitigación: límite de entradas co…",
    ])
  })

  test("tasks: every task, the current one with ◉ and «◀ ahora»", () => {
    const lines = render(twoChanges(), at("tasks"))
    const p = panel(texts(lines))
    expect(p[0]).toStartWith("  tasks · tasks.md (16 tareas)")
    expect(p).toContain("   2. Integración  2/5")
    expect(p).toContain("     ◉ 2.3 Cachear precios por región  ◀ ahora")
    expect(p).toContain("     ○ 4.3 Nota de despliegue")
    expect(p.join("\n")).not.toContain("Progreso")
    expect(segmentsWith(lines, "◀ ahora")[0]!.color).toBe("accent")
  })

  test("verify: verdict and summary; fail and unknown", () => {
    const p = panel(show(twoChanges(), at("verify")))
    expect(p.slice(0, 3)).toEqual(["  verify · verify-report.md", "   ✓ pasa", "     · Verdict: PASS WITH WARNINGS"])
    const model = twoChanges()
    model.changes[0]!.detail!.verify = { verdict: "fail", summary: ["Veredicto: FAIL"] }
    const failed = render(model, at("verify"))
    expect(panel(texts(failed))[1]).toBe("   ✗ falla")
    expect(segmentsWith(failed, "✗")[0]!.color).toBe("error")
    model.changes[0]!.detail!.verify = { verdict: "unknown", summary: [] }
    expect(panel(show(model, at("verify")))[1]).toBe("   ? veredicto sin determinar")
  })

  test("archive: pending and recommended next", () => {
    const model = twoChanges()
    model.changes[0]!.status = priceCacheStatus({ nextRecommended: "archive" })
    expect(panel(show(model, at("archive")))).toEqual(["  archive", "   pendiente de archivar", "   ▸ siguiente: archive"])
  })
})

describe("missing artifacts", () => {
  test("no specs, design, verify-report or apply-progress: muted line with the path", () => {
    const model = twoChanges()
    const dir = "openspec/changes/fix-om-decimals"
    expect(panel(show(model, at("spec", 1)))).toEqual(["  spec · specs", `   sin specs · ${dir}/specs/<capability>/spec.md`])
    expect(panel(show(model, at("design", 1)))).toEqual(["  design · design.md", `   sin design · ${dir}/design.md`])
    expect(panel(show(model, at("verify", 1)))).toEqual(["  verify · verify-report.md", `   sin verify-report · ${dir}/verify-report.md`])
    expect(panel(show(model, at("apply", 1))).at(-1)).toBe(`   sin apply-progress · ${dir}/apply-progress.md`)
    const lines = render(model, at("design", 1))
    expect(segmentsWith(lines, "sin design")[0]!.color).toBe("muted")
  })

  test("missing proposal and proposal without sections", () => {
    const model = twoChanges()
    delete model.changes[1]!.detail!.proposal
    expect(panel(show(model, at("propose", 1)))[1]).toBe("   sin proposal · openspec/changes/fix-om-decimals/proposal.md")
    model.changes[1]!.detail!.proposal = { changes: [], capabilities: [] }
    expect(panel(show(model, at("propose", 1))).join(" ")).toContain("proposal sin secciones reconocidas")
  })

  test("change without loaded detail: loading… or no detail", () => {
    const model: DetailModel = { changes: [{ status: omDecimalsStatus() }], loading: true }
    expect(panel(show(model, at("spec")))).toEqual(["  spec · specs", "   cargando…"])
    delete model.loading
    expect(panel(show(model, at("tasks")))).toEqual(["  tasks · tasks.md (2 tareas)", "   sin detalle de este cambio"])
  })
})

describe("drift warnings and blocks", () => {
  test("specs after tasks: in spec, tasks and apply; not in propose, design, verify, explore or archive", () => {
    const model = twoChanges()
    for (const phase of ["spec", "tasks", "apply"] as const) {
      const p = panel(show(model, at(phase)))
      expect(p[0], phase).toEndWith(STALE)
      expect(p[1], phase).toEndWith("specs 10:42 · tasks 09:15")
    }
    for (const phase of ["explore", "propose", "design", "verify", "archive"] as const) {
      expect(joined(model, at(phase)), phase).not.toContain("cambiaron tras")
    }
    const lines = render(model, at("apply"))
    expect(segmentsWith(lines, STALE)[0]!.color).toBe("warning")
  })

  test("design after verify-report: in design and verify, not in tasks", () => {
    const model = twoChanges()
    model.changes[0]!.status = priceCacheStatus({
      stale: [
        { upstream: "design", downstream: "verifyReport", upstreamFile: "/r/d", upstreamMtime: T_SPECS, downstreamFile: "/r/v", downstreamMtime: T_TASKS },
      ],
    })
    expect(panel(show(model, at("design")))[0]).toEndWith("⚠ design cambió tras verify-report")
    expect(panel(show(model, at("verify")))[0]).toEndWith("⚠ design cambió tras verify-report")
    expect(joined(model, at("tasks"))).not.toContain("cambió tras")
  })

  test("no room in the header: the warning moves to its own line", () => {
    const p = panel(show(twoChanges(), at("spec"), 60))
    expect(p[0]).toBe("  spec · 2 capacidades · 6 requisitos")
    expect(p[1]).toEndWith(STALE)
    expect(p[2]).toEndWith("specs 10:42 · tasks 09:15")
  })

  test("apply blocked: reasons in red only in apply and ✗ bloqueado in the list", () => {
    const model = twoChanges()
    model.changes[0]!.status = priceCacheStatus({
      phases: { ...priceCacheStatus().phases, design: "todo", apply: "blocked" },
      blocked: ["apply bloqueado: falta design"],
      stale: [],
    })
    const lines = render(model, at("apply"))
    const t = texts(lines)
    expect(t[2]).toMatch(/^ ▸ add-price-cache +✗ bloqueado +AB#48213$/)
    expect(panel(t)[1]).toBe("  ✗ apply bloqueado: falta design")
    expect(segmentsWith(lines, "apply bloqueado: falta design")[0]!.color).toBe("error")
    expect(t.find((l) => l.includes("explore"))).toContain("[✗ apply]")
    expect(joined(model, at("tasks"))).not.toContain("falta design")
  })
})

describe("global states", () => {
  test("no changes: hint to get started", () => {
    expect(show({ changes: [] }, at("explore"))).toEqual([
      " openspec-status · SDD",
      " " + "─".repeat(98),
      " no hay cambios SDD activos · empieza: sdd-new <nombre> u openspec new change <nombre>",
      HELP_100,
    ])
  })

  test("loading with no changes yet", () => {
    expect(show({ changes: [], loading: true }, at("explore")).at(-2)).toBe(" cargando…")
  })

  test("error: warning line, and whatever is there is still drawn", () => {
    const model = { ...twoChanges(), error: "sdd-status falló: timeout" }
    const lines = render(model, at("apply"))
    expect(texts(lines)[2]).toBe(" ⚠ sdd-status falló: timeout")
    expect(segmentsWith(lines, "timeout")[0]!.color).toBe("warning")
    expect(texts(lines)).toContain("     ◉ 2.3 Cachear precios por región  ◀ ahora")
    expect(show({ changes: [], error: "x" }, at("explore"))).toContain(" ⚠ x")
  })

  test("out-of-range index: clamped to the last change", () => {
    expect(show(twoChanges(), at("spec", 7))[3]).toStartWith(" ▸ fix-om-decimals")
  })
})

/** Body of the apply panel at 76 columns (no header): 25 lines; the current one, line 8. */
const APPLY_BODY = () => panel(show(twoChanges(), at("apply"), 76)).slice(2)
/** With height 20 at 76 columns, 9 lines remain for the apply panel (10 fixed above, 1 for keys). */
const APPLY_ROOM = 9
const applyPanel = (scroll?: number) => panel(texts(render(twoChanges(), at("apply", 0, scroll), 76, 20))).slice(2)

describe("limited height", () => {
  test("the panel window follows the current task", () => {
    const t = show(twoChanges(), at("apply"), 76)
    const lines = texts(render(twoChanges(), at("apply"), 76, 20))
    expect(lines).toHaveLength(20)
    expect(lines).toContain("     ◉ 2.3 Cachear precios por región  ◀ ahora")
    expect(lines.at(-2)).toMatch(/^ {3}… \d+ más$/)
    expect(lines.at(-1)).toStartWith(" ↑↓ cambio")
    expect(t.length).toBeGreaterThan(20)
  })

  test("no focus: from the top; with room to spare, in full and the bar at the very bottom", () => {
    const lines = texts(render(twoChanges(), at("propose"), 76, 16))
    expect(lines).toHaveLength(16)
    expect(lines.at(-2)).toMatch(/^ {3}… \d+ más$/)
    const whole = show(twoChanges(), at("design"), 76)
    const tall = texts(render(twoChanges(), at("design"), 76, 200))
    expect(tall).toHaveLength(200)
    expect(tall.slice(0, whole.length - 1)).toEqual(whole.slice(0, -1))
    expect(tall.slice(whole.length - 1, -1).every((l) => l === "")).toBe(true)
    expect(tall.at(-1)).toBe(whole.at(-1))
  })

  test("the initial position is the one given by the panel measurements", () => {
    const body = APPLY_BODY()
    expect(body).toHaveLength(25)
    expect(body[8]).toBe("     ◉ 2.3 Cachear precios por región  ◀ ahora")
    expect(panelScroll(twoChanges(), at("apply"), 76, 20)).toEqual({ scroll: 4, max: 25 - APPLY_ROOM, page: APPLY_ROOM - 1 })
    expect(applyPanel()).toEqual(applyPanel(4))
  })

  test("each scroll step moves the text one line and the notices count what is hidden", () => {
    const body = APPLY_BODY()
    expect(applyPanel(0)).toEqual([...body.slice(0, APPLY_ROOM - 1), "   … 17 más"])
    expect(applyPanel(1)).toEqual(["   … 2 más arriba", ...body.slice(2, APPLY_ROOM), "   … 16 más"])
    expect(applyPanel(5)).toEqual(["   … 6 más arriba", ...body.slice(6, 5 + APPLY_ROOM - 1), "   … 12 más"])
    expect(applyPanel(16)).toEqual(["   … 17 más arriba", ...body.slice(17)])
  })

  test("the scroll is clamped to [0, max]", () => {
    expect(applyPanel(99)).toEqual(applyPanel(16))
    expect(applyPanel(-3)).toEqual(applyPanel(0))
    expect(panelScroll(twoChanges(), at("apply", 0, 99), 76, 20).scroll).toBe(16)
  })

  test("if the panel fits, there is no scroll", () => {
    expect(panelScroll(twoChanges(), at("design"), 76, 200)).toEqual({ scroll: 0, max: 0, page: expect.any(Number) })
    expect(texts(render(twoChanges(), at("design", 0, 5), 76, 200))).toEqual(texts(render(twoChanges(), at("design"), 76, 200)))
  })
})

describe("key bar", () => {
  test("last line, muted and with the keys in bold", () => {
    const lines = render(twoChanges(), at("apply"), 100, 30)
    expect(texts(lines).at(-1)).toBe(HELP_100)
    const bar = lines.at(-1)!
    expect(bar.every((s) => s.color === "muted")).toBe(true)
    for (const [key] of detailHelp()) expect(bar.find((s) => s.text === key), key).toMatchObject({ bold: true })
  })

  test("skips what does not fit, keeps esc and never exceeds the width", () => {
    for (const width of [40, 60, 100, 170]) {
      const bar = render(twoChanges(), at("apply"), width, 24).at(-1)!
      expect(lineWidth(bar), `@${width}`).toBeLessThanOrEqual(width)
      expect(lineText(bar), `@${width}`).toStartWith(" ↑↓ cambio  ←→ fase")
      expect(lineText(bar), `@${width}`).toContain("esc volver")
    }
    expect(lineText(render(twoChanges(), at("apply"), 40).at(-1)!)).toBe(" ↑↓ cambio  ←→ fase  esc volver")
    expect(lineText(render(twoChanges(), at("apply"), 60).at(-1)!)).toBe(" ↑↓ cambio  ←→ fase  RePág/AvPág desplazar  esc volver")
    expect(lineText(render(twoChanges(), at("apply"), 100).at(-1)!)).toBe(HELP_100)
    expect(lineText(render(twoChanges(), at("apply"), 170).at(-1)!)).toBe(HELP_100)
  })

  test("the overview one, with or without tab", () => {
    const general = [["↑↓", "desplazar"], ["tab", "detalle SDD"], ["esc", "volver"]] as const
    expect(lineText(helpBar(general, 100))).toBe(" ↑↓ desplazar  tab detalle SDD  esc volver")
    expect(lineText(helpBar([general[0], general[2]], 100))).toBe(" ↑↓ desplazar  esc volver")
    expect(lineText(helpBar(general, 30))).toBe(" ↑↓ desplazar  esc volver")
    expect(lineText(helpBar(general, 8))).toBe(" esc vo…")
  })
})

// ── Widths ──────────────────────────────────────────────────────────────────

function models(): [string, DetailModel][] {
  const blocked = twoChanges()
  blocked.changes[0]!.status = priceCacheStatus({ phases: { ...priceCacheStatus().phases, apply: "blocked" }, blocked: ["apply bloqueado: faltan proposal, spec y design por un motivo muy largo que hay que ajustar"] })
  const long = twoChanges()
  long.changes[0]!.status = priceCacheStatus({ name: "un-cambio-con-un-nombre-larguísimo-que-no-cabe-en-la-lista-de-cambios-activos" })
  long.changes[0]!.detail!.workItem = { ref: "https://tracker.example.com/proyecto/incidencias/123456789/detalle", system: "url", url: "https://tracker.example.com/proyecto/incidencias/123456789/detalle", source: "openspec-yaml" }
  const wide = twoChanges()
  wide.changes[0]!.detail!.tasks!.groups[0]!.items[0]!.text = "タスク ✅ con texto ancho ⏳ y más texto para que no quepa en ninguna anchura razonable de terminal"
  return [
    ["two changes", twoChanges()],
    ["blocked", blocked],
    ["long names", long],
    ["wide text", wide],
    ["no detail", { changes: [{ status: omDecimalsStatus() }, { status: priceCacheStatus() }], loading: true }],
    ["om only", { changes: [{ status: omDecimalsStatus(), detail: omDecimalsDetail() }] }],
    ["price only", { changes: [{ status: priceCacheStatus(), detail: priceCacheDetail() }] }],
    ["pinned", { ...twoChanges(), pinned: "add-price-cache", branch: "feature/48213-add-price-cache" }],
    ["new", { ...twoChanges(), pinned: "add-price-cache", pinnedNew: true, branch: "feature/48213-add-price-cache" }],
    ["empty", { changes: [] }],
    ["error", { changes: [], error: "sdd-status falló con un mensaje de error bastante largo que no cabe en una línea" }],
  ]
}

describe("no line exceeds its width", () => {
  for (const [name, model] of models()) {
    test(name, () => {
      for (const width of [40, 60, 100, 170]) {
        for (const phase of SDD_PHASES) {
          for (const index of [0, 1]) {
            const check = (lines: Line[]) => {
              for (const line of lines) expect(lineWidth(line), `${name} @${width} ${phase}#${index}: «${lineText(line)}»`).toBeLessThanOrEqual(width)
            }
            check(render(model, at(phase, index), width))
            check(render(model, at(phase, index), width, 18))
          }
        }
      }
    })
  }
})

// ── Mockup ──────────────────────────────────────────────────────────────────

test("apply panel mockup at 76 columns", () => {
  expect(show(twoChanges(), at("apply"), 76)).toEqual([
    " openspec-status · SDD",
    " ──────────────────────────────────────────────────────────────────────────",
    " ▸ add-price-cache  apply 6/16 ⚠    AB#48213",
    "   fix-om-decimals  spec ▸ design",
    " ──────────────────────────────────────────────────────────────────────────",
    "  ✓ explore ─ ✓ propose ─ ✓ spec ─ ✓ design ─",
    "  ✓ tasks ─[◉ apply]─ ○ verify ─ ○ archive",
    " ──────────────────────────────────────────────────────────────────────────",
    "  apply · tasks.md (6/16)                      ⚠ specs cambiaron tras tasks",
    "                                                  specs 10:42 · tasks 09:15",
    "   1. Caché  4/4",
    "     ✓ 1.1 Clave por región y producto",
    "     ✓ 1.2 TTL configurable",
    "     ✓ 1.3 Límite de memoria con expulsión LRU",
    "     ✓ 1.4 Métricas de aciertos y fallos",
    "   2. Integración  2/5",
    "     ✓ 2.1 Leer precios a través de la caché en el endpoint",
    "     ✓ 2.2 Envolver el cliente de tarifas con reintentos y espera exponenci…",
    "     ◉ 2.3 Cachear precios por región  ◀ ahora",
    "     ○ 2.4 Invalidar al publicar censo",
    "     ○ 2.5 Cabecera X-Cache en las respuestas",
    "   3. Pruebas  0/4",
    "     ○ 3.1 Acierto y fallo de caché",
    "     ○ 3.2 Caducidad por TTL",
    "     ○ 3.3 Invalidación regional y global",
    "     ○ 3.4 Carga con límite de memoria",
    "   4. Documentación  0/3",
    "     ○ 4.1 Parámetro PRICE_CACHE_TTL",
    "     ○ 4.2 Métricas nuevas",
    "     ○ 4.3 Nota de despliegue",
    "   Progreso · apply-progress.md",
    "     · 6/6 marcadas",
    "     · Lote 1: caché",
    "     · Lote 2: integración",
    "     · Estado: tests unitarios PASS (24 pruebas, 0 failed)",
    " ↑↓ cambio  ←→ fase  RePág/AvPág desplazar  enter fijar  esc volver",
  ])
})
