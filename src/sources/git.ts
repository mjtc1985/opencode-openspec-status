// `git --no-optional-locks status --porcelain` → `GitState`.

import { join } from "node:path"
import type { GitState } from "../model.ts"
import { type Fsx, type Run, gitStatusArgs, nodeFs } from "./exec.ts"

export function parseGitStatus(stdout: string): GitState {
  return { kind: "repo", dirty: stdout.split(/\r?\n/).some((l) => l.trim() !== "") }
}

/** Without `.git` nothing is spawned. Only throws if `run` throws. */
export async function loadGit(root: string, run: Run, fsx: Fsx = nodeFs): Promise<GitState> {
  if (!(await fsx.exists(join(root, ".git")))) return { kind: "none" }
  return parseGitStatus(await run("git", gitStatusArgs(), { cwd: root }))
}
