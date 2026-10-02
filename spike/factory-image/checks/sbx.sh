echo "-- bwrap as root:   $(bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev true 2>&1 | head -1 | cut -c1-70) rc=$?"
echo "-- bwrap as factory: $(su factory -c 'bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev true' 2>&1 | head -1 | cut -c1-70)"
su factory -c 'cd /home/factory && codex sandbox -- echo SANDBOX-STARTED' > /tmp/cs.txt 2>&1; echo "-- codex sandbox as factory rc=$?: $(head -c 300 /tmp/cs.txt | tr '\n' ' ')"
