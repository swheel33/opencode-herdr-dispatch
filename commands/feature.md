---
description: Dispatch a naturally described feature to an OpenCode Build agent in a Herdr worktree.
agent: plan
---

Treat this command as explicit approval to dispatch one implementation task to Herdr. Use the current conversation and `$ARGUMENTS` as the feature request.

Inspect the repository and produce a complete, self-contained implementation plan. Include the goal, agreed behavior, technical decisions, relevant files and architecture, acceptance criteria, tests, cautions, and unresolved details.

Resolve Git intent from natural language:

- When an existing local branch, remote branch, pull request, or another person's feature branch is mentioned, default to `continue`.
- Use `branch_from` only when the user asks to branch off, stack on, use work as a base, or keep changes separate.
- Otherwise use `new` from `HEAD` and choose a short descriptive branch name.
- Resolve remote branch names from repository state. Ask one concise question only when multiple branches match or intent cannot be determined safely.
- For `continue`, use the existing branch name as the local branch when possible and pass the existing local or remote-tracking ref as `source`.
- For `branch_from`, choose a new local branch and pass the existing ref as `source`.
- If the primary checkout is dirty, explain that its uncommitted changes will not be present in the worktree and ask before setting `allowDirtyRoot`.

Choose a concise human-readable title for the Herdr sidebar. Call `dispatch_to_herdr` exactly once with the resolved structured intent and full plan. Do not create worktrees through Bash and do not retry an unclear or failed result. Report the returned mode, source/base, branch, workspace, pane, worktree, and agent.
