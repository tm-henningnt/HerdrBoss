# ADR 0021: The first plan covers the personal fleet only

Status: Accepted. Owner decision, factories interview round 3, item `plan-scope`.

## Decision

The final spec `docs/specs/factories.md` and its tickets cover: the spike, Linux portability, the factory image, the host tool with the `local` and `ssh` transports, the Windows host, the fleet summary, the head office with factory shares and guidance, the manual head office move, the small project transfer, and the move of factory zero into OrbStack.

These parts stay in `docs/ideas/factories.md` for a later spec: users and roles (access G1 to G4), client factories and client sites, automatic election, signed grants, Portainer, the in-host agent, and the offline update bundle.

## Consequences

- The first client factory needs a later spec for access G1 and client sites first.
- The rules for client factories that ADRs 0006, 0007 and 0016 state stay valid for that later spec.

## Alternatives rejected

- The personal fleet plus access G1.
- The full proposal.
