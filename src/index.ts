import { realpath } from "node:fs/promises"

import { tool, type Plugin } from "@opencode-ai/plugin"

import { formatDispatchResult, HerdrDispatcher } from "./dispatch.js"
import { NodeCommandRunner } from "./process.js"

const HerdrDispatchPlugin: Plugin = async ({ client }) => {
  const dispatcher = new HerdrDispatcher({
    runner: new NodeCommandRunner(),
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
    tool: {
      dispatch_to_herdr: tool({
        description:
          "Create, continue, or branch from a feature in a Herdr Git worktree, start a fresh OpenCode Build agent, and deliver a complete implementation plan. Call exactly once from the /feature workflow.",
        args: {
          mode: tool.schema
            .enum(["new", "continue", "branch_from"])
            .describe("Resolved Git intent. Users express this naturally; the /feature workflow selects it."),
          title: tool.schema
            .string()
            .max(80)
            .describe("Short human-readable feature title shown in the Herdr sidebar"),
          branch: tool.schema
            .string()
            .describe("Local Git branch to use in the implementation worktree"),
          plan: tool.schema
            .string()
            .describe("Complete, self-contained implementation plan for the fresh agent"),
          source: tool.schema
            .string()
            .optional()
            .describe("Existing local or remote-tracking branch for continue or branch_from"),
          base: tool.schema
            .string()
            .optional()
            .describe(
              "Git base ref for a new feature. Defaults to HEAD in the primary checkout.",
            ),
          allowDirtyRoot: tool.schema
            .boolean()
            .optional()
            .describe("Explicitly allow dispatch when the primary checkout has uncommitted files"),
        },
        async execute(args, context) {
          const input = {
            mode: args.mode,
            title: args.title,
            branch: args.branch,
            plan: args.plan,
            ...(args.source === undefined ? {} : { source: args.source }),
            ...(args.base === undefined ? {} : { base: args.base }),
            ...(args.allowDirtyRoot === undefined
              ? {}
              : { allowDirtyRoot: args.allowDirtyRoot }),
          }
          return formatDispatchResult(
            await dispatcher.dispatch(context.directory, input, context.abort),
          )
        },
      }),
    },
  }
}

export default HerdrDispatchPlugin
