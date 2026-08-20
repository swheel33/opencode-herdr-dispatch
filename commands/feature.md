---
description: Dispatch a naturally described feature to an OpenCode Build agent in a Herdr worktree.
agent: herdr-feature-coordinator
subtask: true
---

Treat this command as a request to select and dispatch all distinct implementation features agreed in the relevant parent-thread discussion.

The command arguments are an optional filter or clarification: `$ARGUMENTS`.

The plugin supplies bounded parent-thread context. Identify independently implementable features, inspect the repository, and prepare a complete plan, title, branch, and Git intent for each one. Combine tightly coupled changes rather than creating dependent features in the same batch.

When exactly one clear feature is detected, dispatch it immediately without implementation confirmation. When multiple features are detected, present them in one multi-select question and dispatch only the confirmed selection. Clarification and dirty-checkout approval are still required when applicable. Call `dispatch_features_to_herdr` exactly once. Do not call `dispatch_to_herdr`, create worktrees through Bash, or retry an unclear or failed result.

Report every selected feature's branch, workspace, pane, worktree, agent, and failure state.
