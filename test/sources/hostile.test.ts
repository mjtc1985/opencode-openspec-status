// Hostile inputs for the parsers: a committed file must not freeze the TUI
// thread (it is parsed on every poll) nor blow the stack.

import { describe, expect, test } from "bun:test"
import { parseOddDoc, stripRouteNotes } from "../../src/sources/odd.ts"
import { MAX_ITEMS, MAX_LINE, parseHeading, splitLines } from "../../src/sources/markdown.ts"
import { firstOpenTask } from "../../src/sources/sdd.ts"
import {
  parseApplyProgress,
  parseDesign,
  parseGitHead,
  parseGitRemote,
  parseOpenspecYaml,
  parseProposal,
  parseSpec,
  parseTasks,
  parseVerifyReport,
  plain,
} from "../../src/sources/sdd-detail.ts"

const BUDGET_MS = 200

function fast(name: string, input: string, fn: (s: string) => unknown) {
  test(`${name} in under ${BUDGET_MS} ms`, () => {
    const start = performance.now()
    fn(input)
    expect(performance.now() - start).toBeLessThan(BUDGET_MS)
  })
}

const MD_PARSERS: [string, (s: string) => unknown][] = [
  ["ODD", (s) => parseOddDoc(s, "x.md")],
  ["proposal", parseProposal],
  ["design", parseDesign],
  ["spec", (s) => parseSpec(s, "c", "f")],
  ["tasks", parseTasks],
  ["apply-progress", parseApplyProgress],
  ["verify-report", parseVerifyReport],
  ["first task of tasks.md", firstOpenTask],
]

describe("no catastrophic backtracking", () => {
  const spaces = " ".repeat(4000)
  const inputs: [string, string][] = [
    ["4 KB heading of spaces", `# a${spaces}b\n`],
    ["unterminated 4 KB heading", `## a${spaces}\u2028x\n`],
    ["40k headings", "# a\n".repeat(40_000)],
    ["200k subheadings", "## Capabilities\n## Decisions\n" + "### x\n".repeat(200_000)],
    ["bullet with spaces and an odd separator", `- [ ] a${spaces}b\n- x${spaces}\u2028\n`],
    ["table with many spaces", `| a${spaces}b\n`.repeat(50)],
    ["unclosed links", "[".repeat(40_000)],
    ["unclosed italics", "## Why\n\n" + "(*a ".repeat(10_000)],
  ]
  for (const [what, input] of inputs) for (const [parser, fn] of MD_PARSERS) fast(`${parser}: ${what}`, input, fn)

  fast("stripRouteNotes with 40k dots", "a" + ".".repeat(40_000) + "x", stripRouteNotes)
  fast("stripRouteNotes with 40k spaces", "a" + " ".repeat(40_000) + "x", stripRouteNotes)
  fast("plain with 40k [", "[".repeat(40_000), plain)
  fast("plain with 40k ](", "[a](".repeat(10_000), plain)
  fast("yaml with a value full of spaces", `k: a${" ".repeat(40_000)}b\nw: x${" ".repeat(40_000)}#`, parseOpenspecYaml)
  fast("git config with a url full of spaces", `[remote "origin"]\n url = a${" ".repeat(40_000)}b\n`, parseGitRemote)
  fast("HEAD full of spaces", `ref: refs/heads/a${" ".repeat(40_000)}b\n`, parseGitHead)
})

describe("caps", () => {
  test("lines are cut at MAX_LINE and split on every line terminator", () => {
    const lines = splitLines(`${"x".repeat(MAX_LINE * 3)}\r\na\rb\u2028c`)
    expect(lines.map((l) => l.length)).toEqual([MAX_LINE, 1, 1, 1])
  })

  test("headings: same result as the old regex", () => {
    expect(parseHeading("## Título ##")).toEqual({ level: 2, title: "Título" })
    expect(parseHeading("#   ")).toEqual({ level: 1, title: "" })
    expect(parseHeading("### A # #  ")).toEqual({ level: 3, title: "A #" })
    expect(parseHeading("#sin espacio")).toBeUndefined()
    expect(parseHeading("####### siete")).toBeUndefined()
  })

  test("no more than MAX_ITEMS tasks or headings are collected", () => {
    const odd = parseOddDoc("## Tareas\n" + "- [ ] T1 x\n".repeat(MAX_ITEMS * 3), "x.md")
    expect(odd.tasks.length).toBeLessThanOrEqual(MAX_ITEMS)
    const design = parseDesign("## Decisions\n" + "### d\n".repeat(MAX_ITEMS * 3))
    expect(design.decisions.length).toBeLessThanOrEqual(MAX_ITEMS)
    const tasks = parseTasks("## G\n" + "- [ ] 1.1 x\n".repeat(MAX_ITEMS * 3))
    expect(tasks.groups[0]!.items.length).toBeLessThanOrEqual(MAX_ITEMS)
  })

  test("200k capability subheadings do not blow the stack", () => {
    expect(() => parseProposal("## Capabilities\n" + "### x\n".repeat(200_000))).not.toThrow()
  })
})
