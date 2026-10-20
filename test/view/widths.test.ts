import { describe, expect, test } from "bun:test"
import { SIDEBAR_WIDTH } from "../../src/model.ts"
import { compactLabel } from "../../src/view/compact.ts"
import { renderFull } from "../../src/view/full.ts"
import { renderSidebar } from "../../src/view/sidebar.ts"
import { lineText, lineWidth } from "../../src/view/text.ts"
import { view } from "./helpers.ts"
import { CASES } from "./snapshots.ts"

// Characters that some terminal may draw two columns wide: not allowed.
const FORBIDDEN = /[\u{1F000}-\u{1FFFF}\u{2B00}-\u{2BFF}⟲]|[\uFE0F]/u

describe("no line exceeds its width", () => {
  for (const [name, snapshot] of Object.entries(CASES)) {
    test(name, () => {
      const v = view(snapshot)
      for (const line of renderSidebar(v)) {
        expect(lineWidth(line), `${name}: «${lineText(line)}»`).toBeLessThanOrEqual(SIDEBAR_WIDTH)
        expect(lineText(line)).not.toMatch(FORBIDDEN)
      }
      // 36: the real usable width of the OpenCode 1.18.33 sidebar (see tui.tsx).
      for (const line of renderSidebar(v, 36)) expect(lineWidth(line), `${name} @36: «${lineText(line)}»`).toBeLessThanOrEqual(36)
      for (const width of [40, 60, 80, 100, 170]) {
        for (const line of renderFull(v, width)) expect(lineWidth(line), `${name} @${width}: «${lineText(line)}»`).toBeLessThanOrEqual(width)
      }
      const label = compactLabel(v)
      if (label) expect(lineText(label)).not.toMatch(FORBIDDEN)
    })
  }
})
