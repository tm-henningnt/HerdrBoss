# Run wrapper scenarios in fresh panes and print the detected agent per scenario.
F=/home/factory/fakebin/claude
ws=$(herdr workspace create --cwd /home/factory --label f7 --no-focus | sed -E 's/.*"root_pane":\{[^}]*"pane_id":"([^"]+)".*/\1/')
run() {
  p=$(herdr pane split "$ws" --direction down --no-focus | sed -E 's/.*"pane_id":"([^"]+)".*/\1/')
  herdr pane send-text "$p" "$2" >/dev/null; herdr pane send-keys "$p" Enter >/dev/null
  sleep 3; a=$(herdr pane get "$p" | grep -o '"agent":"[a-z]*"' || echo none); echo "$1: $a"
}
run direct "$F"
run bash-child "bash -c '$F; true'"
run env-wrapper "env FOO=1 $F"
run node-wrapper "node -e \"require('child_process').spawnSync('$F',{stdio:'inherit'})\""
