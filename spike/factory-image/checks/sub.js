const net = require('net');
const s = net.createConnection(process.env.HOME + '/.config/herdr/herdr.sock');
let buf = '';
s.on('connect', () => s.write(JSON.stringify({ id: 'sub1', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.updated', pane_id: 'w1:p1' }, { type: 'pane.agent_status_changed', pane_id: 'w1:p2' }, { type: 'layout.updated' }] } }) + '\n'));
s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let t = '?'; try { const j = JSON.parse(l); t = j.event?.type || j.result?.type || j.type || Object.keys(j).join(','); } catch {} console.log(Date.now(), t, t==='id,error' ? l.slice(0,200) : ''); } });
s.on('close', () => { console.log('closed'); process.exit(0); });
setTimeout(() => process.exit(0), Number(process.env.DUR || 60000));
