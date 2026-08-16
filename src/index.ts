import { realpath } from "node:fs/promises"

import { tool, type Plugin } from "@opencode-ai/plugin"

import { formatDispatchResult, HerdrDispatcher } from "./dispatch.js"
import { NodeCommandRunner } from "./process.js"

export { formatDispatchResult, HerdrDispatcher, parseWorktreeResult } from "./dispatch.js"
export { CommandError, DispatchError, formatCommandFailure } from "./errors.js"
export { NodeCommandRunner } from "./process.js"
export type * from "./types.js"
export {
  MIN_PLAN_LENGTH,
  resolveRepository,
  validateBranch,
  validateDispatchInput,
  validatePlan,
} from "./validation.js"

export const HerdrDispatchPlugin: Plugin = async ({ client }) => {
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
          "Create and focus a Herdr Git worktree, start a fresh OpenCode V1 Build agent, and deliver a complete implementation plan. Call exactly once after explicit implementation approval.",
        args: {
          branch: tool.schema
            .string()
            .describe("New Git branch name for the implementation worktree"),
          plan: tool.schema
            .string()
            .describe("Complete, self-contained implementation plan for the fresh agent"),
          base: tool.schema
            .string()
            .optional()
            .describe(
              "Git base ref. Defaults to HEAD, meaning the current commit in the primary planning checkout.",
            ),
        },
        async execute(args, context) {
          const input = {
            branch: args.branch,
            plan: args.plan,
            ...(args.base === undefined ? {} : { base: args.base }),
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
