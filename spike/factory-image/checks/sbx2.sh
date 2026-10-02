su factory -c 'echo SECRET > /home/factory/.config/secret-login; cd /home/factory; echo "unsandboxed write ok"; 
codex sandbox -- sh -c "echo X > /home/factory/written 2>&1; echo write-rc=\$?" 2>&1 | head -3;
codex sandbox -- sh -c "cat /home/factory/.config/secret-login 2>&1 | head -1; echo read-rc=\$?" 2>&1 | head -3;
codex sandbox -- sh -c "id -un; ls /proc | head -2 | tr \"\\n\" \" \"" 2>&1 | head -3'
