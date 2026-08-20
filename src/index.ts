import { realpath } from "node:fs/promises"

import { tool, type Plugin } from "@opencode-ai/plugin"

import { dispatchBatch, formatBatchDispatchResult } from "./batch.js"
import { HerdrDispatcher } from "./dispatch.js"
import { DispatchError } from "./errors.js"
import { NodeCommandRunner } from "./process.js"
import {
  configureFeatureWorkflow,
  FEATURE_COORDINATOR_AGENT,
  renderParentThreadContext,
} from "./workflow.js"

const dispatchFeatureSchema = {
  id: tool.schema
    .string()
    .min(1)
    .max(20)
    .describe("Stable selection ID from the confirmation list, such as F1"),
  mode: tool.schema
    .enum(["new", "continue", "branch_from"])
    .describe("Resolved Git intent"),
  title: tool.schema
    .string()
    .max(80)
    .describe("Short human-readable feature title shown in the Herdr sidebar"),
  branch: tool.schema.string().describe("Local Git branch for this feature"),
  plan: tool.schema
    .string()
    .describe("Complete, self-contained implementation plan for this feature only"),
  source: tool.schema
    .string()
    .optional()
    .describe("Existing local or remote-tracking branch for continue or branch_from"),
  base: tool.schema
    .string()
    .optional()
    .describe("Git base ref for a new feature; defaults to HEAD"),
}

const HerdrDispatchPlugin: Plugin = async ({ client, directory }) => {
  const runner = new NodeCommandRunner()
  const dispatcher = new HerdrDispatcher({
    runner,
    realpath,
    logger(level, message, metadata) {
      void client.app
        .log({
          body: {
            service: "opencode-herdr-dispatch",
            level,
            message,
            ...(metadata ? { extra: metadata } : {}),
          },
        })
        .catch(() => {})
    },
  })

  return {
    config: async (config) => {
      configureFeatureWorkflow(config)
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "feature") return

      const response = await client.session.messages({
        path: { id: input.sessionID },
        query: { directory },
      })
      if (!response.data) {
        throw new DispatchError(
          `Could not load parent-thread context for /feature: ${JSON.stringify(response.error)}`,
        )
      }

      const subtask = output.parts.find(
        (part) => part.type === "subtask" && part.agent === FEATURE_COORDINATOR_AGENT,
      )
      if (!subtask || subtask.type !== "subtask") {
        throw new DispatchError(
          "/feature did not resolve to the Herdr feature coordinator subtask.",
        )
      }

      const context = renderParentThreadContext(response.data)
      subtask.prompt = `${subtask.prompt}\n\n${context}`
      void client.app
        .log({
          body: {
            service: "opencode-herdr-dispatch",
            level: "debug",
            message: "Parent-thread context attached to feature coordinator",
            extra: {
              sessionID: input.sessionID,
              messageCount: response.data.length,
              contextLength: context.length,
            },
          },
        })
        .catch(() => {})
    },
    tool: {
      inspect_herdr_repository: tool({
        description:
          "Read the Git state needed to plan Herdr feature dispatches. Returns status, local and remote branches, remotes, and recent commits without changing the repository.",
        args: {},
        async execute(_args, context) {
          if (context.agent !== FEATURE_COORDINATOR_AGENT) {
            throw new DispatchError(
              `Repository dispatch inspection is restricted to the ${FEATURE_COORDINATOR_AGENT} agent.`,
            )
          }

          const commands = [
            ["status", "--short", "--branch"],
            ["branch", "--all", "--no-color"],
            ["remote", "-v"],
            ["log", "-20", "--oneline", "--decorate"],
          ] as const
          const [status, branches, remotes, log] = await Promise.all(
            commands.map((args) =>
              runner.run({
                executable: "git",
                args,
                cwd: context.directory,
                signal: context.abort,
              }),
            ),
          )
          return [
            "Git status:",
            status?.stdout.trim() || "<clean>",
            "",
            "Branches:",
            branches?.stdout.trim() || "<none>",
            "",
            "Remotes:",
            remotes?.stdout.trim() || "<none>",
            "",
            "Recent commits:",
            log?.stdout.trim() || "<none>",
          ].join("\n")
        },
      }),
      dispatch_features_to_herdr: tool({
        description:
          "Dispatch one confirmed selection of independent implementation features to separate Herdr worktrees and OpenCode Build agents. The /feature coordinator calls this exactly once after the user confirms the list.",
        args: {
          features: tool.schema
            .array(tool.schema.object(dispatchFeatureSchema))
            .min(1)
            .max(8)
            .describe("The confirmed features, in the same order shown to the user"),
          allowDirtyRoot: tool.schema
            .boolean()
            .optional()
            .describe(
              "Explicitly allow all selected dispatches when the primary checkout has uncommitted files",
            ),
        },
        async execute(args, context) {
          if (context.agent !== FEATURE_COORDINATOR_AGENT) {
            throw new DispatchError(
              `Batch dispatch is restricted to the ${FEATURE_COORDINATOR_AGENT} agent.`,
            )
          }

          const input = {
            features: args.features.map((feature) => ({
              id: feature.id,
              mode: feature.mode,
              title: feature.title,
              branch: feature.branch,
              plan: feature.plan,
              ...(feature.source === undefined ? {} : { source: feature.source }),
              ...(feature.base === undefined ? {} : { base: feature.base }),
            })),
            ...(args.allowDirtyRoot === undefined
              ? {}
              : { allowDirtyRoot: args.allowDirtyRoot }),
          }
          return formatBatchDispatchResult(
            await dispatchBatch(
              dispatcher,
              runner,
              context.directory,
              input,
              context.abort,
            ),
          )
        },
      }),
    },
  }
}

export default HerdrDispatchPlugin
