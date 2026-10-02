# ADR 0018: The spike runs on the Mac, then on the Windows host

Status: Accepted. Owner decision, factories interview round 3, item `spike-hosts`.

## Decision

The spike runs first on the Mac with OrbStack (arm64). Then the same container steps run on the Windows home server with Docker Engine in WSL2 (amd64). The Windows part also tests the Docker context over SSH, the Codex sandbox in WSL2, and the Herdr server in WSL2.

## Consequences

- The image is tested on both CPU types before the first container factory.
- The Windows host gets Docker Engine in WSL2 and Tailscale during the spike.

## Alternatives rejected

- The Windows host only. arm64 stays untested until factory zero moves.
- The Mac only. The WSL2 facts stay open until the first factory.
