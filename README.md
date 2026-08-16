# opencode-herdr-dispatch

A small OpenCode V1 plugin that hands a self-contained implementation plan from a read-only Project Chat session to a fresh OpenCode Build agent in a new Herdr Git worktree workspace.

The plugin exposes one typed tool, `dispatch_to_herdr`, with `branch`, `plan`, and optional `base` inputs. It uses argument-array process spawning, performs no hidden network operations, and never modifies the primary checkout or cleans up worktrees automatically.

## Requirements

- Linux or macOS
- Stable OpenCode V1
- Herdr 0.8 or newer
- Git
- Node.js 20 or newer to install dependencies and build the local plugin

On Omarchy, stable OpenCode is normally available as `opencode` and launched through `c`.

## Omarchy Setup

Install Herdr:

```sh
curl -fsSL https://herdr.dev/install.sh | sh
```

Install Herdr's OpenCode integration:

```sh
herdr integration install opencode
```

Clone this repository to a stable local path, install dependencies, and build it:

```sh
git clone <repository-url> ~/.local/share/opencode-herdr-dispatch
cd ~/.local/share/opencode-herdr-dispatch
npm install
npm run build
```

Add the built plugin to `~/.config/opencode/opencode.json`. Replace the example home directory with your absolute path; environment variables and `~` are not expanded inside a `file://` URL.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/YOUR_USER/.local/share/opencode-herdr-dispatch/dist/index.js"
  ]
}
```

Install the included Project Chat agent from the repository checkout:

```sh
mkdir -p ~/.config/opencode/agents
cp agents/project-chat.md ~/.config/opencode/agents/project-chat.md
```

The safer helper refuses to overwrite a different existing file unless forced:

```sh
./scripts/install-agent.sh
./scripts/install-agent.sh --force
```

Restart OpenCode after installing or changing the plugin or agent definition. OpenCode loads configuration only at startup.

## Logging

The plugin writes structured events through OpenCode's logger for each dispatch stage: request validation, repository resolution, worktree creation, agent startup, and plan delivery. Failures include the redacted dispatch error. Plan contents are never logged; only their character count is included.

To see logs while running OpenCode directly:

```sh
opencode --print-logs
```

Set OpenCode's log level to `DEBUG` if you also want input-validation events:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "logLevel": "DEBUG"
}
```

## Usage

1. Start Herdr in the primary Git checkout.
2. Run `c`.
3. Select the `project-chat` primary agent.
4. Discuss requirements and inspect the repository.
5. Say "implement this."
6. Project Chat sends its complete plan through `dispatch_to_herdr` exactly once.
7. The implementation appears in the newly focused Herdr worktree workspace under a fresh OpenCode Build agent.

`base` defaults to `HEAD`. Here, `HEAD` means the current commit in the primary planning checkout at dispatch time. The tool rejects bare repositories and linked-worktree checkouts; planning should happen in the primary checkout.

## Dispatch Behavior

The plugin runs these commands without shell interpolation:

```text
git check-ref-format --branch <branch>
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse --is-bare-repository
herdr worktree create --cwd <repository-root> --branch <branch> --base <base> --focus
herdr agent start <agent-name> --kind opencode --pane <pane-id> --timeout 60000 -- --agent build
herdr agent prompt <agent-name> <plan>
```

The generated agent name is unique, starts with a letter, uses only lowercase letters, digits, `_`, and `-`, and is at most 32 characters. Concurrent dispatches for the same canonical repository and branch are rejected within one plugin process.

Failures identify the executable, redacted argument list, termination status or signal, stdout, and stderr. The complete plan is redacted from prompt-command errors. A failed prompt is never retried automatically because duplicate implementation prompts are unsafe.

## Lifecycle Limitations

- The new OpenCode session receives only the generated plan; it does not inherit the planning transcript.
- The root planning session remains open.
- Worktree deletion is explicit through Herdr.
- Herdr does not delete branches.
- No worktree, branch, or partial dispatch cleanup happens automatically.
- The plugin does not monitor merges, prune worktrees, target existing branches or PRs, or perform custom reset, pull, rebase, or push operations.

## Development

```sh
npm install
npm run typecheck
npm run build
```

## License

MIT
