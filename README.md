# opencode-herdr-dispatch

An OpenCode plugin that turns implementation ideas discussed in a thread into independent background Herdr feature workspaces. It creates or reopens Git worktrees, links local environment files, prepares 70/30 agent and shell layouts, starts OpenCode Build agents, and delivers self-contained handoffs.

The plugin registers a `/feature` command and an isolated `herdr-feature-coordinator` subagent. The coordinator reads bounded conversational context since the previous `/feature`, identifies one or more independent implementation features, and asks the user to confirm a multi-select list. Every selected feature uses one deterministic Git strategy:

- `new`: create a new branch from `HEAD` or an explicit base.
- `continue`: fetch and continue an existing local or remote branch. This is the default when an existing branch, PR, or another person's work is mentioned.
- `branch_from`: create a separate branch from existing work when the user explicitly asks to branch off or keep changes separate.

## Requirements

- OpenCode V1
- Herdr 0.8 or newer
- Git
- Node.js 20 or newer for development

Install Herdr's OpenCode integration separately so Herdr can report and restore agent state:

```sh
herdr integration install opencode
```

## Install

Clone, install, and build at a stable path:

```sh
git clone https://github.com/swheel33/opencode-herdr-dispatch.git ~/Work/opencode-herdr-dispatch
cd ~/Work/opencode-herdr-dispatch
npm ci
npm run build
```

Load the compiled plugin:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/YOUR_USER/Work/opencode-herdr-dispatch/dist/index.js"
  ]
}
```

Restart OpenCode after installation. The plugin registers the command, coordinator, and least-privilege dispatch permissions at startup. Existing installations may remove the old copied `~/.config/opencode/commands/feature.md` and the obsolete Plan-agent permission override; the plugin replaces the shipped legacy command in memory either way.

## Usage

Run OpenCode in a repository's primary checkout. Discuss one or more implementation ideas, then invoke `/feature`:

```text
/feature
/feature only the architecture proposals
/feature include tests on Alice's existing vault filtering branch
```

The coordinator inspects the repository, resolves branch intent, creates concise sidebar titles, and produces complete independent plans. It always asks for final selection confirmation, including when it detects only one feature. One batch call then starts up to three selected dispatches concurrently. A batch accepts at most eight features, rejects duplicate target branches before dispatch, and reports each result independently.

The first `/feature` in a thread receives its visible user and assistant discussion. Later invocations receive discussion since the previous `/feature`, preventing old features and injected child prompts from recursively contaminating new work. Reasoning and tool output are excluded, and context is bounded. Use command arguments to explicitly bring back an older or cancelled proposal.

The primary checkout must be clean by default because uncommitted files are not present in a new worktree. After explicit user confirmation, the coordinator may set `allowDirtyRoot` for an intentional override.

Remote sources are fetched before worktree creation. When a target branch already has a registered worktree, the plugin opens it instead of creating a duplicate checkout. Starting a fresh Build agent still requires the selected worktree's root pane to be an available shell. Batch execution is not transactional: successful and partially created workspaces remain available when another selected feature fails.

Feature workspaces are created without changing the user's focus. New single-pane workspaces are split 70/30 with the Build agent in the top pane and an interactive shell in the bottom pane. Ignored `.env` and `.env.*` files from the primary checkout are symlinked into matching worktree paths; tracked examples are left untouched and existing destination files are never overwritten. Agent startup tolerates the short interval between pane creation and shell readiness.

## Worktree Lifecycle

Herdr owns lifecycle UI; this project does not install a Herdr plugin and never removes worktrees automatically.

Right-click a linked worktree in Herdr:

- `Close` parks the Herdr space and retains the checkout.
- `Delete worktree checkout...` safely removes the space and checkout, with a force confirmation for dirty or untracked files.

Herdr retains the Git branch in both cases.

## Commands

The plugin uses argv spawning without shell interpolation. Depending on strategy and existing state, it runs a subset of:

```text
git status --porcelain --untracked-files=all
git remote
git fetch --no-tags <remote> <branch>
git rev-parse --verify <source>^{commit}
herdr worktree list --cwd <repository-root>
herdr worktree create --cwd <root> --branch <branch> --base <base> --label <title> --no-focus
herdr worktree open --cwd <root> --path <path> --label <title> --no-focus
herdr pane layout --pane <pane>
herdr pane split --pane <pane> --direction down --ratio 0.7 --cwd <worktree> --no-focus
herdr agent start <name> --kind opencode --pane <pane> --timeout 60000 -- --agent build
herdr agent prompt <name> <plan> --wait --until working --timeout 60000
```

Plan contents are redacted from command errors and logs. Prompt delivery succeeds only after the OpenCode integration reports that the newly submitted message is being processed. If Herdr reports a stalled prompt, the plugin inspects the agent and retries delivery once only when it is still idle at the unchanged state sequence; all other timeout or stalled states return an explicit error. The worktree, pane, and agent are preserved after failures, and partial dispatches are never cleaned up automatically.

## Development

```sh
npm ci
npm run typecheck
npm run build
```

## License

MIT
