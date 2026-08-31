# opencode-herdr-dispatch

An OpenCode plugin for turning an agreed implementation plan into a background Herdr worktree and OpenCode Build agent.

The plugin provides:

- `/feature` for selecting and dispatching cohesive implementation outcomes.
- Safe Git worktree creation without changing the primary checkout.
- A 70/30 agent and shell pane layout.
- Herdr tab names synchronized with OpenCode session titles.
- Periodic `develop` refresh and cleanup of worktrees whose GitHub pull requests have closed.

## Requirements

- OpenCode V1
- Herdr 0.8 or newer
- Herdr's OpenCode integration
- Git
- GitHub CLI (`gh`), authenticated for automatic PR cleanup
- Node.js 20 or newer
- pnpm for installing dependencies in new worktrees

Install Herdr's OpenCode integration once:

```sh
herdr integration install opencode
```

## Install

Clone and build the plugin at a stable path:

```sh
git clone https://github.com/swheel33/opencode-herdr-dispatch.git ~/Work/opencode-herdr-dispatch
cd ~/Work/opencode-herdr-dispatch
npm ci
npm run build
```

Add the compiled plugin to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/YOUR_USER/Work/opencode-herdr-dispatch/dist/index.js"
  ]
}
```

Use an absolute `file://` URL. OpenCode does not expand `~` or environment variables in plugin paths.

Do not separately install `commands/feature.md` or an agent definition. The plugin registers its command, coordinator, tools, and permissions at runtime. Remove any copied legacy `/feature` command or `dispatch_to_herdr` permission override from older installations.

Restart OpenCode after installing, rebuilding, or changing its configuration.

## Usage

Discuss the work in a primary checkout, then run:

```text
/feature
/feature only the architecture proposal
/feature continue Alice's existing filtering branch
```

The hidden `herdr-feature-coordinator` reads the relevant conversation since the previous `/feature`, reuses an implementation-ready plan when one exists, resolves the Git strategy, and dispatches the work.

One cohesive outcome creates one worktree. Multiple worktrees are used only for independently valuable changes that can be implemented and merged separately. When multiple outcomes are found, the coordinator asks one multi-select question before dispatching them.

The coordinator may ask for clarification when:

- The requested behavior or feature grouping is ambiguous.
- An existing branch or pull request cannot be identified safely.
- Project instructions conflict with the supplied plan.
- The primary checkout is dirty and an override is required.

## Git Strategies

Each dispatch uses one strategy:

- `new`: create a branch from a freshly fetched and pinned base. Without an explicit base, this uses `origin`'s advertised default branch.
- `continue`: reopen an existing local or remote branch. Mentions of existing work default to this strategy.
- `branch_from`: create separate work based on another branch when explicitly requested.

The dispatcher validates the repository, branch, base commit, worktree path, and primary-checkout state before starting an agent. It never resets or repairs the primary checkout. Concurrent batch results are independent, so successful or partially created workspaces remain available if another dispatch fails.

## Worktree Setup

For a new worktree, the plugin:

1. Creates the Herdr worktree without changing focus.
2. Links ignored `.env` and `.env.*` files from the primary checkout without overwriting existing files.
3. Runs `pnpm install`.
4. Creates or validates a 70/30 top-agent and bottom-shell layout.
5. Starts an OpenCode Build agent.
6. Delivers the implementation plan and waits for OpenCode to begin processing it.

Existing worktrees skip dependency installation. Unexpected pane layouts fail safely instead of being rearranged.

OpenCode processes inside linked worktrees receive only tab-title synchronization. They cannot invoke `/feature` or recursively dispatch more worktrees.

## Tabs And Maintenance

OpenCode root-session titles are matched to Herdr's reported agent sessions and applied to the corresponding tabs. When OpenCode exits, the plugin clears a title it still owns so the tab returns to its numeric label until a new session is titled. Herdr derives tab width from label length, so named tabs expand automatically. Herdr 0.8 does not expose a separate tab-width setting.

In a primary checkout, maintenance is requested at startup and every 15 minutes. Multiple OpenCode tabs can use the same primary checkout safely: a repository-scoped lease and last-success timestamp ensure maintenance runs only once per repository per interval.

Each successful maintenance run:

1. Fetches and prunes `origin`.
2. Fast-forwards local `develop` to `origin/develop` when safe.
3. Lists linked worktrees and their same-repository GitHub pull requests.
4. Removes worktrees for closed or merged PRs when the PR head still matches the worktree commit.

Missing, dirty, or diverged `develop` branches are left untouched. An open matching PR always preserves its worktree. Branches without a matching PR are ignored.

Closed-PR cleanup calls Herdr with `--force`. Dirty and untracked worktree files are deleted along with the Herdr workspace, tabs, and panes. The Git branch itself is retained. The commit check prevents an older PR from deleting a newly reused branch.

## Updating

```sh
cd ~/Work/opencode-herdr-dispatch
git pull
npm ci
npm test
npm run typecheck
npm run build
```

Restart OpenCode after rebuilding.

## Development

Focused tests cover title synchronization, concurrent title updates, `develop` fast-forwarding, PR cleanup, and maintenance lease suppression:

```sh
npm test
npm run typecheck
npm run build
```

The real end-to-end workflow requires a running Herdr server, OpenCode provider credentials, the configured plugin, and Herdr's OpenCode integration:

```sh
npm run test:e2e
```

The E2E test creates disposable repositories, worktrees, panes, and agents and may incur model usage. Set `E2E_MODEL=provider/model-id`, `E2E_TIMEOUT_MS=<milliseconds>`, or `E2E_SCENARIO=independent,agents-conflict` to customize it.

## License

MIT
