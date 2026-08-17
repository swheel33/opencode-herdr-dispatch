import assert from "node:assert/strict"
import test from "node:test"

import {
  HerdrDispatcher,
  parseWorktreeListResult,
  parseWorktreeResult,
} from "../dist/index.js"

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0, signal: null })

class RecordingRunner {
  commands = []

  constructor(handler) {
    this.handler = handler
  }

  async run(command) {
    this.commands.push(command)
    return this.handler(command)
  }
}

function repositoryCommand(command) {
  const args = command.args.join(" ")
  if (args === "check-ref-format --branch sam/new-feature") return ok()
  if (args === "rev-parse --show-toplevel") return ok("/repo\n")
  if (args === "rev-parse --git-dir") return ok(".git\n")
  if (args === "rev-parse --git-common-dir") return ok(".git\n")
  if (args === "rev-parse --is-bare-repository") return ok("false\n")
  if (args === "status --porcelain --untracked-files=all") return ok()
  return undefined
}

test("parses Herdr worktree create and list responses", () => {
  assert.deepEqual(
    parseWorktreeResult(JSON.stringify({
      result: {
        workspace: { workspace_id: "w2" },
        root_pane: { pane_id: "w2:p1" },
        worktree: { path: "/work/feature", branch: "sam/feature" },
        already_open: false,
      },
    })),
    {
      workspaceId: "w2",
      paneId: "w2:p1",
      path: "/work/feature",
      branch: "sam/feature",
      alreadyOpen: false,
    },
  )

  assert.deepEqual(
    parseWorktreeListResult(JSON.stringify({
      result: {
        worktrees: [
          { path: "/repo", branch: "main" },
          {
            path: "/work/feature",
            branch: "sam/feature",
            open_workspace_id: "w2",
          },
        ],
      },
    })),
    [
      { path: "/repo", branch: "main" },
      { path: "/work/feature", branch: "sam/feature", openWorkspaceId: "w2" },
    ],
  )
})

test("creates a titled new worktree and starts a Build agent", async () => {
  const runner = new RecordingRunner((command) => {
    const repositoryResult = repositoryCommand(command)
    if (repositoryResult) return repositoryResult
    const args = command.args.join(" ")
    if (args === "worktree list --cwd /repo") {
      return ok(JSON.stringify({ result: { worktrees: [{ path: "/repo", branch: "main" }] } }))
    }
    if (args === "show-ref --verify --quiet refs/heads/sam/new-feature") {
      const error = new Error("missing")
      error.name = "CommandError"
      error.result = { ...ok(), exitCode: 1 }
      throw error
    }
    if (args.includes("worktree create")) {
      return ok(JSON.stringify({
        result: {
          workspace: { workspace_id: "w2" },
          root_pane: { pane_id: "w2:p1" },
          worktree: { path: "/work/new", branch: "sam/new-feature" },
        },
      }))
    }
    if (command.executable === "herdr" && ["agent", "start"].every((part) => command.args.includes(part))) return ok()
    if (command.executable === "herdr" && command.args[0] === "agent" && command.args[1] === "prompt") return ok()
    throw new Error(`Unexpected command: ${command.executable} ${args}`)
  })
  // commandSucceeds checks the concrete error type, so simulate a missing branch by
  // returning false through a runner wrapper that imports the production error.
  const { CommandError } = await import("../dist/index.js")
  const originalRun = runner.run.bind(runner)
  runner.run = async (command) => {
    try {
      return await originalRun(command)
    } catch (error) {
      if (error?.name === "CommandError" && error?.result) {
        throw new CommandError(command, error.result)
      }
      throw error
    }
  }

  const dispatcher = new HerdrDispatcher({
    runner,
    realpath: async (path) => path === "/repo/.git" ? "/repo/.git" : path,
    createAgentName: () => "h-new-feature",
  })
  const result = await dispatcher.dispatch("/repo", {
    mode: "new",
    title: "Readable feature title",
    branch: "sam/new-feature",
    plan: "Implement the agreed feature with complete tests and verify all acceptance criteria before reporting completion.",
  })

  assert.equal(result.mode, "new")
  assert.equal(result.reusedWorktree, false)
  assert.ok(runner.commands.some((command) =>
    command.args.join(" ").includes("--label Readable feature title")))
})

test("fetches and reopens a continued remote branch", async () => {
  const runner = new RecordingRunner((command) => {
    const args = command.args.join(" ")
    if (args === "check-ref-format --branch alice/feature") return ok()
    if (args === "rev-parse --show-toplevel") return ok("/repo\n")
    if (args === "rev-parse --git-dir") return ok(".git\n")
    if (args === "rev-parse --git-common-dir") return ok(".git\n")
    if (args === "rev-parse --is-bare-repository") return ok("false\n")
    if (args === "status --porcelain --untracked-files=all") return ok()
    if (args === "remote") return ok("origin\n")
    if (args === "fetch --no-tags origin alice/feature") return ok()
    if (args === "rev-parse --verify origin/alice/feature^{commit}") return ok("abc123\n")
    if (args === "worktree list --cwd /repo") {
      return ok(JSON.stringify({
        result: { worktrees: [{ path: "/work/alice-feature", branch: "alice/feature" }] },
      }))
    }
    if (args.includes("worktree open")) {
      return ok(JSON.stringify({
        result: {
          workspace: { workspace_id: "w3" },
          root_pane: { pane_id: "w3:p1" },
          worktree: { path: "/work/alice-feature", branch: "alice/feature" },
          already_open: false,
        },
      }))
    }
    if (command.executable === "herdr" && command.args[0] === "agent") return ok()
    throw new Error(`Unexpected command: ${command.executable} ${args}`)
  })
  const dispatcher = new HerdrDispatcher({
    runner,
    realpath: async (path) => path,
    createAgentName: () => "h-alice-feature",
  })

  const result = await dispatcher.dispatch("/repo", {
    mode: "continue",
    title: "Continue Alice's feature",
    branch: "alice/feature",
    source: "origin/alice/feature",
    plan: "Continue the existing remote feature, preserve its intent, add the requested behavior, and run focused verification.",
  })

  assert.equal(result.base, "origin/alice/feature")
  assert.equal(result.reusedWorktree, true)
  assert.ok(runner.commands.some((command) =>
    command.args.join(" ") === "fetch --no-tags origin alice/feature"))
  assert.ok(runner.commands.some((command) => command.args.includes("open")))
})
