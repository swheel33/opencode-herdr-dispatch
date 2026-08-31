# opencode-herdr-dispatch

An OpenCode plugin that turns cohesive implementation outcomes discussed in a thread into background Herdr feature workspaces. It creates or reopens Git worktrees, links local environment files, enforces 70/30 agent and shell layouts, starts OpenCode Build agents, and delivers self-contained handoffs.

The plugin registers a `/feature` command and an isolated hidden `herdr-feature-coordinator` subagent. The coordinator reads bounded conversational context since the previous `/feature` and groups work by user-visible outcome rather than implementation layer. Supporting UI, API, migration, configuration, refactor, test, and documentation work stays in one dispatch. It creates multiple dispatches only for independently valuable and releasable outcomes with no shared foundation or likely file/contract ownership. A single clear feature dispatches immediately; multiple features require a multi-select confirmation that also accepts grouping corrections. Every selected feature uses one deterministic Git strategy:

- `new`: freshly fetch and pin `origin`'s default branch, or use an explicit base.
- `continue`: fetch and continue an existing local or remote branch. This is the default when an existing branch, PR, or another person's work is mentioned.
- `branch_from`: create a separate branch from existing work when the user explicitly asks to branch off or keep changes separate.

## Requirements

- OpenCode V1
- Herdr 0.8 or newer
- Git
- Node.js 20 or newer

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

Load the compiled plugin from `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/YOUR_USER/Work/opencode-herdr-dispatch/dist/index.js"
  ]
}
```

Use an absolute `file://` URL; `~` and environment variables are not expanded inside it. Do not copy or symlink `commands/feature.md` or an agent definition into OpenCode's config directories. In a primary checkout, the plugin registers the command, coordinator, and least-privilege dispatch permissions at startup. It stays inert when OpenCode starts in a linked worktree, so dispatched Build agents cannot launch another coordinator or nested worktree dispatch.

Existing installations should remove the old copied `~/.config/opencode/commands/feature.md` and obsolete `dispatch_to_herdr` Plan-agent permission override. Restart OpenCode after installation or configuration changes.

After updating the checkout, rebuild the configured artifact before restarting OpenCode:

```sh
git pull
npm ci
npm run typecheck
npm run build
```

## Usage

Run OpenCode in a repository's primary checkout. Discuss one or more implementation ideas, then invoke `/feature`:

```text
/feature
/feature only the architecture proposals
/feature include tests on Alice's existing vault filtering branch
```

When the latest relevant assistant response is already implementation-ready, the coordinator reuses it substantively unchanged instead of planning again. It reads applicable `AGENTS.md` files and asks before changing a supplied plan that conflicts with them. Otherwise it inspects source only to resolve a missing implementation decision and creates the smallest sufficient handoff. The coordinator prefers direct implementations, avoids speculative abstractions and unrequested verification or compatibility work, and treats genuinely greenfield work as having no legacy requirements.

One cohesive feature dispatches without implementation confirmation. Genuinely independent features are presented with independence rationales for multi-select confirmation; a custom response can merge or revise the grouping. Ambiguity and dirty-checkout overrides still require approval. One batch call then starts up to three selected dispatches concurrently. A batch accepts at most eight features, rejects duplicate target branches before dispatch, and reports each result independently.

The first `/feature` in a thread receives its visible user and assistant discussion. Later invocations receive discussion since the previous `/feature`, preventing old features and injected child prompts from recursively contaminating new work. Reasoning and tool output are excluded, and context is bounded. Use command arguments to explicitly bring back an older or cancelled proposal.

The primary checkout must be clean by default because uncommitted files are not present in a new worktree. After explicit user confirmation, the coordinator may set `allowDirtyRoot` for an intentional override.

An unbased new dispatch resolves `origin`'s advertised default branch, fetches it into its remote-tracking ref, pins the fetched commit, and creates the worktree from that OID. It fails without side effects when `origin` or a fresh default-branch fetch is unavailable; use an explicit local base such as `HEAD` only when local state is intentionally desired. Explicit remote sources are also freshly fetched and pinned.

The primary checkout is never a valid dispatch target. Existing linked worktrees may be reopened, but the plugin verifies their repository, branch, and path and confirms that the root branch, commit, and status remain unchanged before starting an agent. OpenCode processes started inside those worktrees do not receive `/feature`, the coordinator, or the dispatch tools. The dispatcher also independently rejects a linked worktree as its source directory. It never resets or repairs the root. Starting a fresh Build agent requires the selected worktree's root pane to be an available shell and its layout to be either one pane or the expected top-agent/bottom-shell 70/30 split. Other existing layouts fail safely rather than being silently reused or rearranged. Batch execution is not transactional: successful and partially created workspaces remain available when another selected feature fails.

Feature workspaces are created without changing the user's focus. Ignored `.env` and `.env.*` files from the primary checkout are linked with absolute symlinks into matching worktree paths; tracked examples are left untouched and existing destination files are never overwritten. The primary checkout remains the source of truth, so moving it breaks those links. After linking local environment files, new worktrees run `pnpm install`; installation must succeed before pane setup or agent startup. Reopened worktrees retain their existing dependencies and skip installation. New single-pane workspaces are then split 70/30 with the Build agent in the top pane and an interactive shell in the bottom pane, and the resulting geometry is verified before agent startup. Agent startup tolerates the short interval between pane creation and shell readiness.

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
git ls-remote --symref origin HEAD
git fetch --no-tags <remote> +refs/heads/<branch>:refs/opencode-herdr-dispatch/<unique-id>
git update-ref refs/remotes/<remote>/<branch> <fetched-commit>
git rev-parse --verify <source>^{commit}
herdr worktree list --cwd <repository-root>
herdr worktree create --cwd <root> --branch <branch> --base <base> --label <title> --no-focus
herdr worktree open --cwd <root> --path <path> --label <title> --no-focus
pnpm install
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

The project intentionally has no mocked unit-test suite. Its test command exercises the configured AI model, the real `/feature` command, OpenCode plugin loading and question API, Git worktrees, Herdr agents and pane geometry, and physical environment-file symlinks in disposable repositories:

```sh
npm run test:e2e
```

The E2E run requires working OpenCode provider credentials, the plugin registered from this checkout, Herdr's current OpenCode integration, and a running Herdr server. It creates real model usage and may incur provider cost. By default it runs one real-AI `/feature` smoke scenario covering plan reuse, fresh origin pinning, Herdr layout, dependency installation, agent startup, nested environment links, and root immutability, followed by fast checks for missing-origin failure, root-checkout protection, and inert plugin setup inside linked worktrees. It does not wait for the Build agent to finish implementation. The slower multi-feature and AGENTS.md conflict scenarios remain opt-in with `E2E_SCENARIO=independent,agents-conflict`. Set `E2E_MODEL=provider/model-id` to override the configured model or `E2E_TIMEOUT_MS` to adjust the ten-minute scenario timeout. Temporary agents, worktrees, repositories, and remotes are force-removed after each scenario, including failures.

## License

MIT
