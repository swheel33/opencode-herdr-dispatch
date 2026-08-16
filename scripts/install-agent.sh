#!/bin/sh
set -eu

force=0
if [ "${1:-}" = "--force" ]; then
  force=1
  shift
fi
if [ "$#" -ne 0 ]; then
  printf '%s\n' "usage: scripts/install-agent.sh [--force]" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_file="$script_dir/../agents/project-chat.md"
target_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/agents"
target_file="$target_dir/project-chat.md"

mkdir -p -- "$target_dir"
if [ -e "$target_file" ]; then
  if cmp -s -- "$source_file" "$target_file"; then
    printf '%s\n' "project-chat agent is already installed: $target_file"
    exit 0
  fi
  if [ "$force" -ne 1 ]; then
    printf '%s\n' "refusing to overwrite existing unmanaged file: $target_file" >&2
    printf '%s\n' "review it, then rerun with --force to replace it" >&2
    exit 1
  fi
fi

cp -- "$source_file" "$target_file"
printf '%s\n' "installed project-chat agent: $target_file"
