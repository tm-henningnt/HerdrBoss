# ADR 0003: Build `qlik-cli` from source for arm64

Status: Accepted. Decided by the planner in the factories interview, round 1. Spec decision 9.

## Context

The factory image is multi-arch. `qlik-cli` v3.3.0 has no arm64 Linux release. Emulation of the amd64 binary needs Rosetta or qemu on each host.

## Decision

Build `qlik-cli` from source in a Go build stage of the factory image. Pin the source version in `pins.json`. Add it to the image in the phase after the first image set.

## Consequences

- The image build needs a Go toolchain stage. The final image holds only the binary.
- An upstream arm64 release later lets the build stage go. That change is local to the Dockerfile.

## Alternatives rejected

- Run the amd64 binary under emulation. It needs a per-host setup and fails on a host without Rosetta or qemu.
- Leave `qlik-cli` out of arm64 images. Qlik projects then cannot run in an arm64 factory.
