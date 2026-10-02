import os, pty, sys, time, select, struct, fcntl, termios, re, signal, subprocess
args = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0: os.execvp(args[0], args)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
t0 = time.time(); killed = None; log = []; last_bytes_t = None; total = 0; ssh_pids = []
def alive():
    try: return os.waitpid(pid, os.WNOHANG) == (0, 0)
    except ChildProcessError: return False
while time.time() - t0 < 40:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        total += len(d); last_bytes_t = time.time() - t0
        if killed is not None and 'first_after' not in globals(): first_after = time.time() - killed; txt = re.sub(rb'\x1b\[[0-9;?<>=]*[ -/]*[@-~]', b'', d).decode('utf8','replace'); print('first output after drop: %.1fs: %r' % (first_after, txt[:120]))
    if killed is None and time.time() - t0 > 5:
        out = subprocess.run(['pgrep', '-P', str(pid), '-x', 'ssh'], capture_output=True, text=True).stdout.split()
        print('ssh children of client:', out)
        for p in out: os.kill(int(p), signal.SIGKILL)
        killed = time.time(); print('killed ssh at t=%.1f' % (killed - t0))
    if killed and time.time() - killed > 25: break
print('client alive at end:', alive(), 'total bytes', total)
try: os.kill(pid, signal.SIGTERM)
except Exception: pass
