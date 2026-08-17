# opencode-herdr-dispatch

An OpenCode plugin that turns an approved implementation plan into a background Herdr feature workspace. It creates or reopens a Git worktree, links local environment files, prepares a 70/30 agent and shell layout, starts an OpenCode Build agent, and delivers a self-contained handoff.

The user-facing workflow is the included `/feature` command. It interprets natural language with OpenCode Plan, then calls the plugin with one deterministic strategy:

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

Load the compiled plugin and deny its tool globally. Explicitly allow only the built-in Plan agent:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/YOUR_USER/Work/opencode-herdr-dispatch/dist/index.js"
  ],
  "permission": {
    "dispatch_to_herdr": "deny"
  },
  "agent": {
    "plan": {
      "permission": {
        "dispatch_to_herdr": "allow"
      }
    }
  }
}
```

Install `commands/feature.md` as `~/.config/opencode/commands/feature.md`, then restart OpenCode. Configuration and plugins are loaded only at startup.

## Usage

Run OpenCode Plan in a repository's primary checkout and describe the task naturally:

```text
/feature add vault filtering
/feature add tests to Alice's existing vault filtering branch
/feature use Alice's vault filtering work as a base but keep my changes separate
```

The command inspects the repository, resolves branch intent, creates a concise sidebar title, produces a complete plan, and invokes `dispatch_to_herdr` once. Ambiguous branch matches require clarification.

The primary checkout must be clean by default because uncommitted files are not present in a new worktree. After explicit user confirmation, Plan may set `allowDirtyRoot` for an intentional override.

Remote sources are fetched before worktree creation. When the target branch already has a registered worktree, the plugin opens it instead of creating a duplicate checkout. Starting a fresh Build agent still requires the selected worktree's root pane to be an available shell.

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
herdr agent prompt <name> <plan>
```

Plan contents are redacted from command errors and logs. Failed prompts are never retried automatically, and partial dispatches are never cleaned up automatically.

## Development

```sh
npm ci
npm run typecheck
npm run build
```

## License

MIT
