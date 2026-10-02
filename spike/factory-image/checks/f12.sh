set -u
cd /home/factory/herdr-boss
IP=$(hostname -i | awk '{print $1}')
mkdir -p /home/f2/.config /home/f2/.herdr-boss
echo '{"allowedHosts":["*.localhost"]}' > /home/factory/.herdr-boss/config.json
echo '{"allowedHosts":["*.localhost"]}' > /home/f2/.herdr-boss/config.json
pkill -x node 2>/dev/null; true
(HOME=/home/f2 HERDR_BOSS_PORT=4478 nohup node src/cli.js serve > /tmp/serve-b.log 2>&1 &)
