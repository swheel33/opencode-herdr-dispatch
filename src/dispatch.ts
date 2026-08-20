import { randomUUID } from "node:crypto"
import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { CommandError, DispatchError } from "./errors.js"
import { NodeCommandRunner } from "./process.js"
import type {
  CommandSpec,
  DispatchDependencies,
  DispatchInput,
  DispatchPartialState,
  DispatchResult,
  WorktreeInfo,
} from "./types.js"
import {
  resolveRepository,
  validateDispatchInput,
  type ValidatedDispatchInput,
} from "./validation.js"

const inFlight = new Set<string>()
const SHELL_READY_RETRY_MS = 100
const SHELL_READY_TIMEOUT_MS = 5_000

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
      already_open?: unknown
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
    ...(typeof result?.already_open === "boolean"
      ? { alreadyOpen: result.already_open }
      : {}),
  }
}

function parsePaneCount(stdout: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr pane layout returned malformed JSON.", {
      cause: error,
    })
  }

  const panes = (parsed as { result?: { layout?: { panes?: unknown } } }).result
    ?.layout?.panes
  if (!Array.isArray(panes)) {
    throw new DispatchError("Herdr pane layout did not include result.layout.panes.")
  }

  return panes.length
}

function herdrErrorCode(error: unknown): string | undefined {
  if (!(error instanceof CommandError)) return undefined

  try {
    const parsed = JSON.parse(error.result.stderr) as {
      error?: { code?: unknown }
    }
    return typeof parsed.error?.code === "string" ? parsed.error.code : undefined
  } catch {
    return undefined
  }
}

function stalledStateChangeSeq(error: unknown): number | undefined {
  if (!(error instanceof CommandError)) return undefined

  try {
    const parsed = JSON.parse(error.result.stderr) as {
      error?: { message?: unknown }
    }
    if (typeof parsed.error?.message !== "string") return undefined
    const match = /state_change_seq remained (\d+)/u.exec(parsed.error.message)
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}

interface AgentState {
  status: string
  stateChangeSeq: number
}

function parseAgentState(stdout: string): AgentState {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr agent inspection returned malformed JSON.", {
      cause: error,
    })
  }

  const agent = (parsed as {
    result?: { agent?: { agent_status?: unknown; state_change_seq?: unknown } }
  }).result?.agent
  if (
    typeof agent?.agent_status !== "string" ||
    typeof agent.state_change_seq !== "number"
  ) {
    throw new DispatchError(
      "Herdr agent inspection did not include result.agent.agent_status and result.agent.state_change_seq.",
    )
  }

  return {
    status: agent.agent_status,
    stateChangeSeq: agent.state_change_seq,
  }
}

function isEnvironmentFile(relativePath: string): boolean {
  const name = path.basename(relativePath)
  const excludedDirectories = new Set([
    ".git",
    ".herdr",
    ".worktrees",
    "node_modules",
  ])
  const isProjectPath = relativePath
    .split(path.sep)
    .every((segment) => !excludedDirectories.has(segment))
  return (
    isProjectPath &&
    (name === ".env" || name.startsWith(".env.")) &&
    !name.endsWith(".example")
  )
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}

export interface ExistingWorktreeInfo {
  path: string
  branch?: string
  openWorkspaceId?: string
}

export function parseWorktreeListResult(stdout: string): ExistingWorktreeInfo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr worktree listing returned malformed JSON.", { cause: error })
  }

  const worktrees = (parsed as { result?: { worktrees?: unknown } }).result?.worktrees
  if (!Array.isArray(worktrees)) {
    throw new DispatchError("Herdr worktree listing did not include result.worktrees.")
  }

  return worktrees.flatMap((entry): ExistingWorktreeInfo[] => {
    if (typeof entry !== "object" || entry === null) return []
    const value = entry as Record<string, unknown>
    if (typeof value.path !== "string") return []
    return [{
      path: value.path,
      ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
      ...(typeof value.open_workspace_id === "string"
        ? { openWorkspaceId: value.open_workspace_id }
        : {}),
    }]
  })
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

async function commandSucceeds(
  dependencies: DispatchDependencies,
  command: CommandSpec,
): Promise<boolean> {
  try {
    await dependencies.runner.run(command)
    return true
  } catch (error) {
    if (error instanceof CommandError && error.result.exitCode === 1) return false
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
      mode: input.mode,
      title: input.title,
      branch: input.branch,
      base: input.base ?? "HEAD",
      ...(input.source ? { source: input.source } : {}),
      planLength: input.plan.length,
    })

    try {
      return await this.dispatchValidated(cwd, input, signal)
    } catch (error) {
      this.log("error", "Dispatch failed", {
        mode: input.mode,
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
      mode: validated.mode,
      title: validated.title,
      branch: validated.branch,
      base: validated.base,
      ...(validated.source ? { source: validated.source } : {}),
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
    await this.assertPrimaryCheckoutSafe(repository.root, validated, signal)
    const base = await this.resolveBase(repository.root, validated, signal)
    const key = `${repository.root}\0${validated.branch}`
    if (inFlight.has(key)) {
      throw new DispatchError(
        `A dispatch for branch ${JSON.stringify(validated.branch)} is already in progress for this repository.`,
      )
    }

    inFlight.add(key)
    const partial: DispatchPartialState = {}
    try {
      const existingWorktree = await this.findExistingWorktree(
        repository.root,
        validated.branch,
        signal,
      )
      if (validated.mode !== "continue" && !existingWorktree) {
        const branchExists = await commandSucceeds(this.dependencies, {
          executable: "git",
          args: ["show-ref", "--verify", "--quiet", `refs/heads/${validated.branch}`],
          cwd: repository.root,
          ...(signal ? { signal } : {}),
        })
        if (branchExists) {
          throw new DispatchError(
            `Branch ${JSON.stringify(validated.branch)} already exists. Use continue intent or choose a new branch.`,
          )
        }
      }

      this.log("info", existingWorktree ? "Opening existing Herdr worktree workspace" : "Creating background Herdr worktree workspace", {
        repository: repository.root,
        mode: validated.mode,
        branch: validated.branch,
        base,
        ...(existingWorktree ? { worktreePath: existingWorktree.path } : {}),
      })
      const worktreeCommand: CommandSpec = {
        executable: "herdr",
        args: existingWorktree
          ? [
              "worktree",
              "open",
              "--cwd",
              repository.root,
              "--path",
              existingWorktree.path,
              "--label",
              validated.title,
              "--no-focus",
            ]
          : [
              "worktree",
              "create",
              "--cwd",
              repository.root,
              "--branch",
              validated.branch,
              "--base",
              base,
              "--label",
              validated.title,
              "--no-focus",
            ],
        cwd: repository.root,
        ...(signal ? { signal } : {}),
      }
      const worktreeOutput = await runStage(
        this.dependencies,
        worktreeCommand,
        existingWorktree
          ? "Existing worktree could not be opened; no agent was started."
          : "Worktree creation failed; no agent was started.",
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
      this.log("info", existingWorktree ? "Herdr worktree workspace opened" : "Herdr worktree workspace created", {
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        ...(worktree.path ? { worktreePath: worktree.path } : {}),
      })
      partial.workspaceId = worktree.workspaceId
      partial.paneId = worktree.paneId
      if (worktree.path) partial.path = worktree.path
      if (!worktree.path) {
        throw new DispatchError(
          "Herdr did not report the worktree path required for environment linking and pane setup.",
        )
      }

      const linkedEnvironmentFiles = await this.linkEnvironmentFiles(
        repository.root,
        worktree.path,
        signal,
      )
      this.log("info", "Linked local environment files into worktree", {
        workspaceId: worktree.workspaceId,
        linkedEnvironmentFiles,
      })

      const layoutOutput = await runStage(
        this.dependencies,
        {
          executable: "herdr",
          args: ["pane", "layout", "--pane", worktree.paneId],
          cwd: repository.root,
          ...(signal ? { signal } : {}),
        },
        "Could not inspect the Herdr worktree pane layout.",
      )
      if (parsePaneCount(layoutOutput) === 1) {
        await runStage(
          this.dependencies,
          {
            executable: "herdr",
            args: [
              "pane",
              "split",
              "--pane",
              worktree.paneId,
              "--direction",
              "down",
              "--ratio",
              "0.7",
              "--cwd",
              worktree.path,
              "--no-focus",
            ],
            cwd: repository.root,
            ...(signal ? { signal } : {}),
          },
          "Could not create the 70/30 Herdr worktree pane layout.",
        )
      }

      const agentName = (this.dependencies.createAgentName ?? createAgentName)(
        validated.branch,
      )
      partial.agentName = agentName
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
      await this.startAgentWhenShellReady(startCommand)
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
        args: [
          "agent",
          "prompt",
          agentName,
          validated.plan,
          "--wait",
          "--until",
          "working",
          "--timeout",
          "60000",
        ],
        cwd: repository.root,
        redactArgs: [3],
        ...(signal ? { signal } : {}),
      }
      await this.deliverPlan(promptCommand, agentName)
      this.log("info", "Implementation plan admitted by OpenCode", {
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        agentName,
      })

      return {
        mode: validated.mode,
        title: validated.title,
        branch: validated.branch,
        base,
        ...(validated.source ? { source: validated.source } : {}),
        reusedWorktree: existingWorktree !== undefined,
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        agentName,
        planDelivered: true,
        ...(worktree.path ? { path: worktree.path } : {}),
        ...(worktree.branch ? { worktreeBranch: worktree.branch } : {}),
      }
    } catch (error) {
      if (Object.keys(partial).length > 0) {
        throw new DispatchError(
          error instanceof Error ? error.message : String(error),
          { cause: error, partial },
        )
      }
      throw error
    } finally {
      inFlight.delete(key)
    }
  }

  private async assertPrimaryCheckoutSafe(
    repositoryRoot: string,
    input: ValidatedDispatchInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const status = await runStage(
      this.dependencies,
      {
        executable: "git",
        args: ["status", "--porcelain", "--untracked-files=all"],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      "Could not inspect the primary checkout before dispatch.",
    )
    if (status.trim() && !input.allowDirtyRoot) {
      throw new DispatchError(
        "The primary checkout has uncommitted files that will not be included in the feature worktree. Confirm this explicitly and dispatch with allowDirtyRoot only if that is intentional.",
      )
    }
  }

  private async linkEnvironmentFiles(
    repositoryRoot: string,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const output = await runStage(
      this.dependencies,
      {
        executable: "git",
        args: [
          "ls-files",
          "-z",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--",
          ":(glob).env",
          ":(glob).env.*",
          ":(glob)**/.env",
          ":(glob)**/.env.*",
        ],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      "Could not discover ignored environment files in the primary checkout.",
    )
    const environmentFiles = output
      .split("\0")
      .filter(Boolean)
      .filter(isEnvironmentFile)
    let linked = 0

    for (const relativePath of environmentFiles) {
      const source = path.join(repositoryRoot, relativePath)
      const destination = path.join(worktreePath, relativePath)
      const sourceStats = await lstat(source)
      if (!sourceStats.isFile() && !sourceStats.isSymbolicLink()) continue

      try {
        const destinationStats = await lstat(destination)
        if (destinationStats.isSymbolicLink()) {
          const target = await readlink(destination)
          if (path.resolve(path.dirname(destination), target) === source) continue
        }

        throw new DispatchError(
          `Refusing to overwrite existing worktree environment file ${JSON.stringify(relativePath)}.`,
        )
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }

      await mkdir(path.dirname(destination), { recursive: true })
      await symlink(source, destination)
      linked += 1
    }

    return linked
  }

  private async startAgentWhenShellReady(command: CommandSpec): Promise<void> {
    const deadline = Date.now() + SHELL_READY_TIMEOUT_MS

    while (true) {
      try {
        await this.dependencies.runner.run(command)
        return
      } catch (error) {
        if (
          herdrErrorCode(error) !== "agent_pane_busy" ||
          Date.now() >= deadline
        ) {
          if (error instanceof CommandError || error instanceof DispatchError) {
            throw new DispatchError(
              `The worktree exists, but no OpenCode agent was started. No cleanup was attempted.\n${error.message}`,
              { cause: error },
            )
          }
          throw error
        }

        await delay(SHELL_READY_RETRY_MS, undefined, {
          ...(command.signal ? { signal: command.signal } : {}),
        })
      }
    }
  }

  private async deliverPlan(command: CommandSpec, agentName: string): Promise<void> {
    const failurePrefix =
      "The workspace and agent exist, but OpenCode did not confirm plan admission. Inspect the existing agent before retrying; no cleanup was attempted."

    try {
      await this.dependencies.runner.run(command)
      return
    } catch (error) {
      const stalledSeq = stalledStateChangeSeq(error)
      if (herdrErrorCode(error) !== "agent_prompt_stalled" || stalledSeq === undefined) {
        if (error instanceof CommandError || error instanceof DispatchError) {
          throw new DispatchError(`${failurePrefix}\n${error.message}`, { cause: error })
        }
        throw error
      }

      const stateOutput = await runStage(
        this.dependencies,
        {
          executable: "herdr",
          args: ["agent", "get", agentName],
          cwd: command.cwd,
          ...(command.signal ? { signal: command.signal } : {}),
        },
        `${failurePrefix}\nThe stalled agent could not be inspected safely.`,
      )
      const state = parseAgentState(stateOutput)
      if (state.status === "working") {
        this.log("info", "Implementation plan admitted after Herdr stall response", {
          agentName,
          stateChangeSeq: state.stateChangeSeq,
        })
        return
      }

      if (state.status !== "idle" || state.stateChangeSeq !== stalledSeq) {
        throw new DispatchError(
          `${failurePrefix}\nHerdr reported ${JSON.stringify(state.status)} at state_change_seq ${state.stateChangeSeq} after the stalled submission; the plan was not retried.`,
          { cause: error },
        )
      }

      this.log("info", "Retrying stalled implementation plan delivery once", {
        agentName,
        stateChangeSeq: state.stateChangeSeq,
      })
      await runStage(this.dependencies, command, failurePrefix)
    }
  }

  private async resolveBase(
    repositoryRoot: string,
    input: ValidatedDispatchInput,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!input.source) return input.base

    const remotesOutput = await runStage(
      this.dependencies,
      {
        executable: "git",
        args: ["remote"],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      "Could not list Git remotes.",
    )
    const remote = remotesOutput
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .find((candidate) => input.source?.startsWith(`${candidate}/`))

    if (remote) {
      const remoteBranch = input.source.slice(remote.length + 1)
      if (!remoteBranch) throw new DispatchError("Remote source branch must not be empty.")
      await runStage(
        this.dependencies,
        {
          executable: "git",
          args: ["fetch", "--no-tags", remote, remoteBranch],
          cwd: repositoryRoot,
          ...(signal ? { signal } : {}),
        },
        `Could not fetch source branch ${JSON.stringify(input.source)}.`,
      )
      await runStage(
        this.dependencies,
        {
          executable: "git",
          args: ["rev-parse", "--verify", `${input.source}^{commit}`],
          cwd: repositoryRoot,
          ...(signal ? { signal } : {}),
        },
        `Fetched source branch ${JSON.stringify(input.source)} could not be resolved.`,
      )
      return input.source
    }

    await runStage(
      this.dependencies,
      {
        executable: "git",
        args: ["rev-parse", "--verify", `${input.source}^{commit}`],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      `Source branch ${JSON.stringify(input.source)} could not be resolved.`,
    )
    return input.source
  }

  private async findExistingWorktree(
    repositoryRoot: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<ExistingWorktreeInfo | undefined> {
    const output = await runStage(
      this.dependencies,
      {
        executable: "herdr",
        args: ["worktree", "list", "--cwd", repositoryRoot],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      "Could not list existing Herdr worktrees.",
    )
    return parseWorktreeListResult(output).find((worktree) => worktree.branch === branch)
  }
}

export function formatDispatchResult(result: DispatchResult): string {
  return [
    "Plan delivered to an OpenCode Build agent in Herdr.",
    `Mode: ${result.mode}`,
    `Feature: ${result.title}`,
    `Branch: ${result.branch}`,
    ...(result.source ? [`Source: ${result.source}`] : []),
    `Base: ${result.base}`,
    `Reused worktree: ${result.reusedWorktree ? "yes" : "no"}`,
    `Workspace ID: ${result.workspaceId}`,
    `Pane ID: ${result.paneId}`,
    `Agent: ${result.agentName}`,
    ...(result.path ? [`Worktree: ${result.path}`] : []),
    "Plan delivered: yes",
  ].join("\n")
}
