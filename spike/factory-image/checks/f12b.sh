IP=$(hostname -i | awk '{print $1}')
TA=$(cat /home/factory/.config/herdr-boss/access-token); TB=$(cat /home/f2/.config/herdr-boss/access-token)
rm -f /tmp/ja /tmp/jb
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
echo "no login, host a.localhost via eth0:   $(code --resolve a.localhost:4477:$IP http://a.localhost:4477/api/state)"
echo "no login, host plain IP:               $(code http://$IP:4477/api/state)"
echo "login A (token A) on a.localhost:      $(code -c /tmp/ja --resolve a.localhost:4477:$IP -d "token=$TA" http://a.localhost:4477/login)"
echo "login B (token B) on b.localhost:      $(code -c /tmp/jb --resolve b.localhost:4478:$IP -d "token=$TB" http://b.localhost:4478/login)"
echo "A cookie -> a.localhost /api/state:    $(code -b /tmp/ja --resolve a.localhost:4477:$IP http://a.localhost:4477/api/state)"
echo "B cookie -> b.localhost /api/state:    $(code -b /tmp/jb --resolve b.localhost:4478:$IP http://b.localhost:4478/api/state)"
echo "A cookie sent to B (crossed):          $(code -b /tmp/ja --resolve b.localhost:4478:$IP http://b.localhost:4478/api/state)"
echo "token A on login B:                    $(code --resolve b.localhost:4478:$IP -d "token=$TA" http://b.localhost:4478/login)"
echo "same name, different port (shared cookie by host): login A on x.localhost:4477, cookie to x.localhost:4478"
code -c /tmp/jx --resolve x.localhost:4477:$IP -d "token=$TA" http://x.localhost:4477/login; echo
echo "  cookie of A at x.localhost:4478 (B server): $(code -b /tmp/jx --resolve x.localhost:4478:$IP http://x.localhost:4478/api/state)"
echo "  B login on x.localhost:4478 then A cookie jar overwritten?"
code -b /tmp/jx -c /tmp/jx --resolve x.localhost:4478:$IP -d "token=$TB" http://x.localhost:4478/login; echo
echo "  A at x.localhost:4477 after B login:       $(code -b /tmp/jx --resolve x.localhost:4477:$IP http://x.localhost:4477/api/state)"
echo "  B at x.localhost:4478 after B login:       $(code -b /tmp/jx --resolve x.localhost:4478:$IP http://x.localhost:4478/api/state)"
