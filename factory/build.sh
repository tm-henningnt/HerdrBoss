#!/bin/sh
# Build the factory image. Usage: build.sh [TAG] [-- extra docker build arguments]
# The script reads pins.json, makes a seed checkout from HEAD with its .git directory, and builds for the CPU type of the host.
# Environment: FACTORY_BUILDER names a buildx builder. FACTORY_LABEL adds one label (key=value) to the image.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
tag=${1:-herdr-boss-factory:dev}
[ "$#" -eq 0 ] || shift
[ "${1:-}" != "--" ] || shift
pin() { node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((o, k) => o?.[k], p); if (typeof v !== "string" || !v) { console.error("pins.json has no value for " + process.argv[2]); process.exit(1); } console.log(v)' "$here/pins.json" "$1"; }
base="$(pin base.image):$(pin base.tag)@$(pin base.digest)"
pins_json=$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))))' "$here/pins.json")
pins_sha=$(shasum -a 256 "$here/pins.json" | cut -d' ' -f1)
# checksums.txt holds one "hash  file" line for each entry of the sha256 object of pins.json.
node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const e = Object.entries(p.sha256 || {}); if (!e.length) { console.error("pins.json has no sha256 object"); process.exit(1); } for (const [f, h] of e) { if (!/^[a-f0-9]{64}$/.test(h)) { console.error("pins.json: bad hash for " + f); process.exit(1); } console.log(h + "  " + f); }' "$here/pins.json" > "$here/checksums.txt"
rm -rf "$here/seed"
trap 'rm -rf "$here/seed" "$here/checksums.txt"' EXIT
git clone --quiet --no-hardlinks "$repo" "$here/seed"
git -C "$here/seed" remote remove origin
label=${FACTORY_LABEL:+--label $FACTORY_LABEL}
# shellcheck disable=SC2086
docker ${FACTORY_BUILDER:+buildx} build ${FACTORY_BUILDER:+--builder "$FACTORY_BUILDER" --load} \
  --build-arg "BASE_IMAGE=$base" \
  --build-arg "S6_VERSION=$(pin s6Overlay)" \
  --build-arg "NODE_VERSION=$(pin node)" \
  --build-arg "HERDR_VERSION=$(pin herdr)" \
  --build-arg "GH_VERSION=$(pin gh)" \
  --build-arg "CLAUDE_CODE_VERSION=$(pin claudeCode)" \
  --build-arg "CODEX_VERSION=$(pin codex)" \
  --build-arg "OPENCODE_VERSION=$(pin opencode)" \
  --build-arg "CHROMIUM_VERSION=$(pin chromium)" \
  --build-arg "PINS_SHA256=$pins_sha" \
  --build-arg "PINS_JSON=$pins_json" \
  --build-arg "BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg "SOURCE_REVISION=$(git -C "$repo" rev-parse HEAD)" \
  $label \
  -t "$tag" "$@" "$here"
