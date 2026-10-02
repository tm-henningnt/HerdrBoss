#!/bin/sh
# Build the spike image. Usage: build.sh [min|codex]
# The seed checkout is a local clone of the worktree HEAD with its .git directory. It holds no uncommitted change.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
target=${1:-min}
rm -rf "$here/seed"
git clone --quiet --no-hardlinks "$(git -C "$here" rev-parse --show-toplevel)" "$here/seed"
git -C "$here/seed" remote remove origin
docker build --target "$target" -t "hf-spike:$target" "$here"
rm -rf "$here/seed"
