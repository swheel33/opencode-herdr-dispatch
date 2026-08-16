import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"

import { CommandError, DispatchError } from "./errors.js"
import { NodeCommandRunner } from "./process.js"
import type {
  CommandSpec,
  DispatchDependencies,
  DispatchInput,
  DispatchResult,
  WorktreeInfo,
} from "./types.js"
import { resolveRepository, validateDispatchInput } from "./validation.js"

const inFlight = new Set<string>()

function createAgentName(branch: string): string {
  const branchPart = branch
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .slice(0, 14)
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10)
  return `h-${branchPart || "dispatch"}-${suffix}`.slice(0, 32)
}

function optionalString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
}

export function parseWorktreeResult(stdout: string): WorktreeInfo {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr worktree creation returned malformed JSON.", {
      cause: error,
    })
  }

  const envelope = parsed as {
    result?: {
      workspace?: Record<string, unknown>
      root_pane?: Record<string, unknown>
      worktree?: Record<string, unknown>
      path?: unknown
      branch?: unknown
    }
  }
  const result = envelope.result
  const workspaceId = result?.workspace?.workspace_id
  const paneId = result?.root_pane?.pane_id
  if (typeof workspaceId !== "string" || typeof paneId !== "string") {
    throw new DispatchError(
      "Herdr worktree creation JSON is missing result.workspace.workspace_id or result.root_pane.pane_id.",
    )
  }

  const path = optionalString(
    result?.worktree?.path,
    result?.workspace?.worktree_path,
    result?.workspace?.cwd,
    result?.path,
  )
  const branch = optionalString(
    result?.worktree?.branch,
    result?.workspace?.branch,
    result?.branch,
  )
  return {
    workspaceId,
    paneId,
    ...(path ? { path } : {}),
    ...(branch ? { branch } : {}),
  }
}

async function runStage(
  dependencies: DispatchDependencies,
  command: CommandSpec,
  failurePrefix: string,
): Promise<string> {
  try {
    return (await dependencies.runner.run(command)).stdout
  } catch (error) {
    if (error instanceof CommandError || error instanceof DispatchError) {
      throw new DispatchError(`${failurePrefix}\n${error.message}`, { cause: error })
    }
    throw error
  }
}

export class HerdrDispatcher {
  constructor(
    private readonly dependencies: DispatchDependencies = {
      runner: new NodeCommandRunner(),
      realpath,
    },
  ) {}

  private log(
    level: "debug" | "info" | "error",
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.dependencies.logger?.(level, message, metadata)
  }

  async dispatch(
    cwd: string,
    input: DispatchInput,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    this.log("info", "Dispatch requested", {
      cwd,
      branch: input.branch,
      base: input.base ?? "HEAD",
      planLength: input.plan.length,
    })

    try {
      return await this.dispatchValidated(cwd, input, signal)
    } catch (error) {
      this.log("error", "Dispatch failed", {
        branch: input.branch,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private async dispatchValidated(
    cwd: string,
    input: DispatchInput,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    const validated = await validateDispatchInput(
      this.dependencies.runner,
      cwd,
      input,
      signal,
    )
    this.log("debug", "Dispatch input validated", {
      branch: validated.branch,
      base: validated.base,
      planLength: validated.plan.length,
    })
    const repository = await resolveRepository(
      this.dependencies.runner,
      cwd,
      this.dependencies.realpath,
      signal,
    )
    this.log("info", "Primary Git checkout resolved", {
      repository: repository.root,
      gitDir: repository.gitDir,
    })
    const key = `${repository.root}\0${validated.branch}`
    if (inFlight.has(key)) {
      throw new DispatchError(
        `A dispatch for branch ${JSON.stringify(validated.branch)} is already in progress for this repository.`,
      )
    }

    inFlight.add(key)
    try {
      this.log("info", "Creating focused Herdr worktree workspace", {
        repository: repository.root,
        branch: validated.branch,
        base: validated.base,
      })
      const worktreeCommand: CommandSpec = {
        executable: "herdr",
        args: [
          "worktree",
          "create",
          "--cwd",
          repository.root,
          "--branch",
          validated.branch,
          "--base",
          validated.base,
          "--focus",
        ],
        cwd: repository.root,
        ...(signal ? { signal } : {}),
      }
      const worktreeOutput = await runStage(
        this.dependencies,
        worktreeCommand,
        "Worktree creation failed; no agent was started.",
      )
      let worktree: WorktreeInfo
      try {
        worktree = parseWorktreeResult(worktreeOutput)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new DispatchError(
          `Herdr reported worktree creation success, but its response was invalid. A worktree may exist, no agent was started, and no cleanup was attempted.\n${detail}`,
          { cause: error },
        )
      }
      this.log("info", "Herdr worktree workspace created", {
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        ...(worktree.path ? { worktreePath: worktree.path } : {}),
      })
      const agentName = (this.dependencies.createAgentName ?? createAgentName)(
        validated.branch,
      )
      this.log("info", "Starting OpenCode Build agent", {
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        agentName,
      })
      const startCommand: CommandSpec = {
        executable: "herdr",
        args: [
          "agent",
          "start",
          agentName,
          "--kind",
          "opencode",
          "--pane",
          worktree.paneId,
          "--timeout",
          "60000",
          "--",
          "--agent",
          "build",
        ],
        cwd: repository.root,
        ...(signal ? { signal } : {}),
      }
      await runStage(
        this.dependencies,
        startCommand,
        "The worktree exists, but no OpenCode agent was started. No cleanup was attempted.",
      )
      this.log("info", "OpenCode Build agent started", {
        paneId: worktree.paneId,
        agentName,
      })

      this.log("info", "Delivering implementation plan", {
        agentName,
        planLength: validated.plan.length,
      })
      const promptCommand: CommandSpec = {
        executable: "herdr",
        args: ["agent", "prompt", agentName, validated.plan],
        cwd: repository.root,
        redactArgs: [3],
        ...(signal ? { signal } : {}),
      }
      await runStage(
        this.dependencies,
        promptCommand,
        "The workspace and agent exist, but plan delivery was not confirmed. Do not retry automatically.",
      )
      this.log("info", "Implementation plan delivered", {
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        agentName,
      })

      return {
        branch: validated.branch,
        base: validated.base,
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        agentName,
        planDelivered: true,
        ...(worktree.path ? { path: worktree.path } : {}),
        ...(worktree.branch ? { worktreeBranch: worktree.branch } : {}),
      }
    } finally {
      inFlight.delete(key)
    }
  }
}

export function formatDispatchResult(result: DispatchResult): string {
  return [
    "Plan delivered to a fresh OpenCode Build agent in Herdr.",
    `Branch: ${result.branch}`,
    `Base: ${result.base}`,
    `Workspace ID: ${result.workspaceId}`,
    `Pane ID: ${result.paneId}`,
    `Agent: ${result.agentName}`,
    ...(result.path ? [`Worktree: ${result.path}`] : []),
    "Plan delivered: yes",
  ].join("\n")
}
