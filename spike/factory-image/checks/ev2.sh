for i in 1 2 3 4 5; do p=$(herdr pane split w1:p1 --direction down --no-focus | sed -E 's/.*"pane_id":"([^"]+)".*/\1/'); sleep 6; herdr pane close "$p" >/dev/null 2>&1; sleep 6; done
