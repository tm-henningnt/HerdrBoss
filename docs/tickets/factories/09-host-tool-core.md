# 09: Host tool core with the local transport

**What to build:** `herdr-boss factory new|build|start|stop|status|list` creates and controls personal factories on the host where it runs.

**Blocked by:** 08: The factory image.

**Status:** ready-for-agent

- [ ] `factory new NAME --profile personal` writes the factory record, creates labeled volumes, builds the image, and creates the container with its hostname and loopback ports.
- [ ] `factory status` shows container state, health, schema, kit revision, factory version, image build date, pins hash, workers, and disk.
- [ ] The tool refuses to run inside a container.
- [ ] The tool refuses a `client` profile on a host whose runtime is for personal use only.
- [ ] Each release states a minimum factory version, and an older factory gets a clear message.
- [ ] Tests use a fake Docker transport that records the calls.
- [ ] No secret is stored in the registry or a factory record.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.
