---
description: Dispatch the agreed plan to a Herdr implementation worktree.
agent: plan
subtask: false
---

Dispatch the agreed scope from this conversation, applying later user corrections: `$ARGUMENTS`.

The plugin registers the complete command at runtime in `src/workflow.ts`; do not install this file separately. A plugin-issued, single-use authorization is required to call the dispatch tool. Stay in Plan mode; implementation runs as `herdr-implementor` in a separate Herdr worktree using the configured model.
