import { expect, test } from "bun:test"
import { LENSES, SDD_PHASES, SIDEBAR_WIDTH } from "../src/model.ts"

test("the contract fixes the 8 SDD phases, the 4 lenses and the sidebar width", () => {
  expect(SDD_PHASES).toEqual(["explore", "propose", "spec", "design", "tasks", "apply", "verify", "archive"])
  expect(LENSES).toEqual(["risk", "resilience", "readability", "reliability"])
  expect(SIDEBAR_WIDTH).toBe(38)
})
