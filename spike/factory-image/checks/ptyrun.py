import os, pty, sys, time, select, struct, fcntl, termios, re, signal
args = sys.argv[2:]
dur = float(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(args[0], args)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
buf = b''; t0 = time.time(); first = None
while time.time() - t0 < dur:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        if first is None: first = time.time() - t0
        buf += d
txt = re.sub(rb'\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]', b'', buf).decode('utf8', 'replace')
words = re.findall(r'[A-Za-z0-9_/.:-]{3,}', txt)
print('first_output_s=%.2f bytes=%d' % (first or -1, len(buf)))
print('words:', ' '.join(words[:60]))
os.kill(pid, signal.SIGTERM)
