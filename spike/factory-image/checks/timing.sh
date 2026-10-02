# usage: timing.sh <repo dir>; prints wall-clock ms for 5 git status runs and one node --test run
cd "$1" || exit 1
now() { node -e 'console.log(Date.now())'; }
for i in 1 2 3 4 5; do s=$(now); git status --porcelain >/dev/null; e=$(now); printf 'git-status#%s %s ms\n' $i $((e-s)); done
s=$(now); HOME=$(mktemp -d) HERDR_BOSS_DIR=$(mktemp -d) node --test --test-concurrency=2 test/config.test.js > /tmp/nt.out 2>&1; rc=$?; e=$(now)
printf 'node-test config.test.js rc=%s %s ms; %s\n' $rc $((e-s)) "$(grep -E '^# (tests|pass|fail)' /tmp/nt.out | tr '\n' ' ')"
