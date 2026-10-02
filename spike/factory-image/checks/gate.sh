#!/bin/sh
# Forced-command gate: log the original command shape, then run it only when it is a Herdr remote helper form.
echo "$(date +%T) orig=$(printf %s "$SSH_ORIGINAL_COMMAND" | head -c 60 | tr '\n' ' ')" >> /home/factory/gate.log
case "$SSH_ORIGINAL_COMMAND" in
  "/bin/sh -s"|"sh -s"|"printf "*herdr-remote-output-ready*|"exec /usr/local/bin/herdr "*|"/bin/sh -c "*"/usr/local/bin/herdr "*|"herdr "*|"/usr/local/bin/herdr "*) exec /bin/sh -c "$SSH_ORIGINAL_COMMAND";;
  *) echo "gate: denied" >&2; exit 126;;
esac
