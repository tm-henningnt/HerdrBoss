#!/bin/sh
# Smoke test of the factory image. Usage: smoke-test.sh [IMAGE]
# With no IMAGE, the script builds one with build.sh. It then starts one container with fresh volumes and checks it.
# Every container, volume, and image that the script makes carries the label herdr-factory-spike=t08. The script removes a
# resource only when its name is one that the script made and the resource carries the label.
# Environment: FACTORY_BUILDER names a buildx builder. SMOKE_FULL_SUITE=1 also runs the full suite.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
label=herdr-factory-spike=t08
label_key=${label%%=*}
label_value=${label#*=}
image=${1:-}
name="hf-smoke-t08-$$-$(date +%s)"
failed=0
built=
pass() { echo "pass: $1"; }
fail() { echo "FAIL: $1"; failed=1; }
check() { if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi; }
# Remove a resource only when it carries the label. KIND is container, volume, or image.
has_label() {
  case "$1" in
    container) value=$(docker container inspect -f "{{index .Config.Labels \"$label_key\"}}" "$2" 2>/dev/null || true);;
    volume) value=$(docker volume inspect -f "{{index .Labels \"$label_key\"}}" "$2" 2>/dev/null || true);;
    image) value=$(docker image inspect -f "{{index .Config.Labels \"$label_key\"}}" "$2" 2>/dev/null || true);;
  esac
  [ "$value" = "$label_value" ]
}
remove_own() {
  if has_label "$1" "$2"; then
    case "$1" in
      container) docker rm -f -v "$2" >/dev/null 2>&1 || true;;
      volume) docker volume rm "$2" >/dev/null 2>&1 || true;;
      image) docker image rm "$2" >/dev/null 2>&1 || true;;
    esac
  fi
}
cleanup() {
  remove_own container "$name"
  for volume in data home work code; do remove_own volume "$name-$volume"; done
  # Remove the image only when this script built it.
  [ -z "$built" ] || remove_own image "$built"
}
# Refuse to start when a resource of one of these names exists. The script never touches a resource that it did not make.
exists() { docker container inspect "$name" >/dev/null 2>&1 && return 0; for v in data home work code; do docker volume inspect "$name-$v" >/dev/null 2>&1 && return 0; done; return 1; }
if exists; then echo "A resource named $name exists. Stop." >&2; exit 2; fi
trap cleanup EXIT
exec_user() { docker exec -u factory "$name" "$@"; }

if [ -z "$image" ]; then
  image="hf-smoke-t08:$$"
  if docker image inspect "$image" >/dev/null 2>&1; then echo "An image named $image exists. Stop." >&2; exit 2; fi
  built=$image
  FACTORY_LABEL="$label" "$here/build.sh" "$image"
fi
for volume in data home work code; do docker volume create --label "$label" "$name-$volume" >/dev/null; done
# Every published port binds to 127.0.0.1. Codex needs the custom seccomp profile and systempaths=unconfined together.
# The security options come from the codexContainer setting of the personal profile in profiles.json.
codex_opts=$(node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1] + "/profiles.json", "utf8")).profiles.personal.codexContainer; if (c.enabled) console.log("--security-opt seccomp=" + process.argv[1] + "/" + c.seccompProfile + " --security-opt systempaths=" + c.systempaths)' "$here")
# shellcheck disable=SC2086
docker run -d --name "$name" --label "$label" \
  $codex_opts \
  --log-opt max-size=10m --log-opt max-file=3 --shm-size 1g \
  -p 127.0.0.1::4477 -p 127.0.0.1::22 \
  -v "$name-data:/home/factory/.herdr-boss" -v "$name-home:/home/factory" \
  -v "$name-work:/home/factory/work" -v "$name-code:/home/factory/herdr-boss" \
  "$image" >/dev/null

# The health check status becomes healthy when /api/health returns 200.
status=starting
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$name")
  [ "$status" = starting ] || break
  sleep 3
done
desc="the Docker health check reports healthy"; [ "$status" = healthy ] && pass "$desc" || fail "$desc (status: $status)"
code=$(docker exec "$name" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4477/api/health || true)
desc="GET /api/health returns 200"; [ "$code" = 200 ] && pass "$desc" || fail "$desc (code: $code)"

desc="the user is factory with UID 1000"; [ "$(exec_user id -u)" = 1000 ] && pass "$desc" || fail "$desc"
desc="the migration ran: herdr-boss.db has a schema version"
version=$(exec_user node -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/home/factory/.herdr-boss/herdr-boss.db",{readOnly:true}); console.log(db.prepare("SELECT max(version) AS v FROM schema_version").get().v)' 2>/dev/null || true)
[ -n "$version" ] && [ "$version" -ge 1 ] 2>/dev/null && pass "$desc (version $version)" || fail "$desc"
desc="the data volume holds the live data directory"
check exec_user test -f /home/factory/.herdr-boss/herdr-boss.db
desc="herdr server runs"
check exec_user herdr status server
desc="the seed checkout has a .git directory on the code volume"
check exec_user test -d /home/factory/herdr-boss/.git
desc="the volume roots belong to factory"
owners=$(docker exec "$name" stat -c '%U' /home/factory /home/factory/.herdr-boss /home/factory/work /home/factory/herdr-boss | sort -u)
[ "$owners" = factory ] && pass "$desc" || fail "$desc ($owners)"

# s6 restarts a service that exits. Kill each service process and wait for a new PID.
for service in sshd "herdr server" "node src/cli.js serve"; do
  desc="s6 restarts: $service"
  old=$(docker exec "$name" pgrep -f -o "$service" || true)
  if [ -z "$old" ]; then fail "$desc (not running)"; continue; fi
  docker exec "$name" kill "$old"
  new=$old
  for _ in $(seq 1 30); do
    new=$(docker exec "$name" pgrep -f -o "$service" 2>/dev/null || true)
    [ -n "$new" ] && [ "$new" != "$old" ] && break
    sleep 1
  done
  [ -n "$new" ] && [ "$new" != "$old" ] && pass "$desc" || fail "$desc"
done
status=starting
for _ in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$name")
  [ "$status" = healthy ] && break
  sleep 3
done
desc="the container is healthy again after the restarts"; [ "$status" = healthy ] && pass "$desc" || fail "$desc (status: $status)"

# The first-start script seeds chromePath with the Linux browser and reads back through the Herdr Boss setting reader.
desc="chromePath reads back as /usr/bin/chromium"
chrome=$(exec_user sh -c 'cd /home/factory/herdr-boss && node -e "import(\"./src/config.js\").then((m) => console.log(m.readRootSettings().chromePath))"' 2>/dev/null || true)
[ "$chrome" = /usr/bin/chromium ] && pass "$desc" || fail "$desc ($chrome)"
desc="the root table of config.toml has the Codex update setting once"
root_setting() { exec_user sh -c 'awk "/^[ \t]*\\[/ {exit} /^check_for_update_on_startup = false\$/ {n++} END {exit n == 1 ? 0 : 1}" /home/factory/.codex/config.toml'; }
check root_setting
# A reused home: an Owner chromePath stays, a true value becomes false in the root table, and other settings stay.
docker exec "$name" sh -c 'printf "{\"chromePath\": \"/opt/own-chrome\"}\n" > /home/factory/.herdr-boss/config.json; printf "model = \"x\"\ncheck_for_update_on_startup = true\n\n[projects.\"/a\"]\ntrust = 1\ncheck_for_update_on_startup = true\n" > /home/factory/.codex/config.toml'
desc="the start script runs again on a reused home"
check docker exec -e PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$name" /etc/cont-init.d/10-factory-home
desc="a restart keeps an Owner chromePath"
[ "$(exec_user node -e 'console.log(JSON.parse(require("fs").readFileSync("/home/factory/.herdr-boss/config.json", "utf8")).chromePath)')" = /opt/own-chrome ] && pass "$desc" || fail "$desc"
desc="a restart sets the Codex update setting to false in the root table and keeps other settings"
check root_setting
desc="a restart keeps the Codex settings of the other tables"
check exec_user sh -c 'grep -q "^model = \"x\"" /home/factory/.codex/config.toml && grep -q "^\[projects" /home/factory/.codex/config.toml && grep -q "^trust = 1" /home/factory/.codex/config.toml && grep -q "^check_for_update_on_startup = true" /home/factory/.codex/config.toml'
docker exec "$name" rm -f /home/factory/.herdr-boss/config.json

# Published ports bind to loopback only.
ports=$(docker port "$name")
desc="every published port binds to 127.0.0.1"
if echo "$ports" | grep -v '^$' | grep -qv '127.0.0.1:'; then fail "$desc"; else pass "$desc"; fi

# Harness self-update is off. Pi is not in the image, so it has no Claude subscription default.
desc="Claude Code self-update is off"; [ "$(docker exec "$name" printenv DISABLE_AUTOUPDATER)" = 1 ] && pass "$desc" || fail "$desc"
desc="OpenCode self-update is off"; [ "$(docker exec "$name" printenv OPENCODE_DISABLE_AUTOUPDATE)" = true ] && pass "$desc" || fail "$desc"
desc="Pi is not installed and no Pi settings name a Claude default"
if exec_user sh -c 'command -v pi' >/dev/null 2>&1 || exec_user sh -c 'grep -rqi anthropic /home/factory/.pi 2>/dev/null'; then fail "$desc"; else pass "$desc"; fi

# The pins are in the OCI labels.
desc="the pins and the pins hash are in the OCI labels"
labels=$(docker image inspect -f '{{index .Config.Labels "org.herdr-boss.pins-sha256"}} {{index .Config.Labels "org.herdr-boss.pins"}}' "$image")
sha=$(shasum -a 256 "$here/pins.json" | cut -d' ' -f1)
case "$labels" in "$sha "*) pass "$desc";; *) fail "$desc";; esac
desc="the installed versions match pins.json"
node_pin=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).node)' "$here/pins.json")
[ "$(exec_user node --version)" = "v$node_pin" ] && pass "$desc (node)" || fail "$desc (node)"
for tool in claude codex opencode gh herdr chromium; do
  desc="$tool starts"; check exec_user "$tool" --version
done

# The Codex sandbox starts with the custom seccomp profile plus systempaths=unconfined.
desc="the Codex sandbox starts"
out=$(exec_user codex sandbox -- echo SANDBOX-STARTED 2>&1 || true)
case "$out" in *SANDBOX-STARTED*) pass "$desc";; *) fail "$desc";; esac

if [ "${SMOKE_FULL_SUITE:-0}" = 1 ]; then
  desc="the full suite passes inside the container"
  # The suite needs the work tree of this checkout. Copy it, with no .git, to a temporary folder in the container.
  tmp=$(mktemp -d)
  (cd "$(git -C "$here" rev-parse --show-toplevel)" && COPYFILE_DISABLE=1 tar --exclude=.git --exclude=node_modules --exclude=factory/seed -cf - .) > "$tmp/tree.tar"
  docker cp "$tmp/tree.tar" "$name:/tmp/tree.tar"
  rm -rf "$tmp"
  exec_user sh -c 'rm -rf /tmp/tree && mkdir /tmp/tree && tar -C /tmp/tree -xf /tmp/tree.tar && cd /tmp/tree && npm test' >${TMPDIR:-/tmp}/factory-smoke-suite.$$.log 2>&1 && pass "$desc" || fail "$desc (log: ${TMPDIR:-/tmp}/factory-smoke-suite.$$.log)"
fi

[ "$failed" = 0 ] && echo "SMOKE TEST PASSED" || { echo "SMOKE TEST FAILED"; exit 1; }
