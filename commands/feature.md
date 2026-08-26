---
description: Dispatch a naturally described feature to an OpenCode Build agent in a Herdr worktree.
agent: herdr-feature-coordinator
subtask: true
---

Treat this command as a request to select and dispatch the cohesive implementation outcome agreed in the relevant parent-thread discussion. Multiple dispatches are appropriate only for genuinely independent outcomes.

The command arguments are an optional filter or clarification: `$ARGUMENTS`.

The plugin supplies bounded parent-thread context and marks the latest relevant assistant response. Reuse that response substantively unchanged when it is an implementation-ready plan and no later request modifies it. Otherwise produce only the smallest sufficient handoff. Read applicable `AGENTS.md` files and ask before dispatch whenever they conflict with a supplied plan. Prefer simple direct implementations; do not invent abstractions, refactors, verification, documentation, migrations, fallbacks, or compatibility layers. Implement greenfield designs directly and preserve only concrete existing contracts.

Group work by user-visible outcome rather than implementation layer. Keep required work for one outcome together without inventing supporting work. Split only when items have no sibling or shared-foundation dependency, are unlikely to modify the same files or contracts, and can be merged in any order. New work defaults to the freshly fetched default branch of `origin`, not the primary checkout's `HEAD`.

When exactly one clear feature is detected, dispatch it immediately without implementation confirmation. When multiple genuinely independent features are detected, explain that each creates a separate concurrent branch and worktree, then call the question tool once with a `questions` array containing exactly one multi-select item. Put every feature and its independence rationale in that item's options, enable custom answers, and never ask one question per feature. Treat a custom response such as "merge F1 and F2" as a request to revise the grouping. Clarification and dirty-checkout approval are still required when applicable. Call `dispatch_features_to_herdr` exactly once. Do not call `dispatch_to_herdr`, create worktrees through Bash, or retry an unclear or failed result.

Report every selected feature's branch, workspace, pane, worktree, agent, and failure state.
