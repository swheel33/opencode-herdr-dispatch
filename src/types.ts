export interface CommandSpec {
  executable: string
  args: readonly string[]
  cwd: string
  signal?: AbortSignal
  redactArgs?: readonly number[]
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface CommandRunner {
  run(command: CommandSpec): Promise<CommandResult>
}

export interface DispatchInput {
  branch: string
  plan: string
  base?: string
}

export interface RepositoryInfo {
  root: string
  gitDir: string
  commonDir: string
}

export interface WorktreeInfo {
  workspaceId: string
  paneId: string
  path?: string
  branch?: string
}

export interface DispatchResult extends WorktreeInfo {
  branch: string
  base: string
  agentName: string
  planDelivered: true
  worktreeBranch?: string
}

export type DispatchLogLevel = "debug" | "info" | "warn" | "error"

export type DispatchLogger = (
  level: DispatchLogLevel,
  message: string,
  metadata?: Record<string, unknown>,
) => void

export interface DispatchDependencies {
  runner: CommandRunner
  realpath(path: string): Promise<string>
  createAgentName?(branch: string): string
  logger?: DispatchLogger
}
