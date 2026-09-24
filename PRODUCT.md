# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Herdr users who coordinate coding agents across multiple projects. The primary user oversees project orchestrators, worker agents, subscription quotas, and a shared computer.

## Product Purpose

Herdr Boss keeps multi-project agent work moving within available subscriptions and machine capacity. Success balances continuity of each project's orchestration with useful worker throughput. It should help users see resource pressure early, allocate workers across projects, and move orchestration to another provider before a quota prevents progress.

## Positioning

Herdr Boss combines live Herdr pane and agent state, provider quota readings, machine and browser ownership, project-published status, and a shared worker kit in one local control plane. Project orchestrators can follow its current bulletin and publish into its dashboard instead of each project building its own resource monitor and dashboard.

## Operating Context

- Runs as a local Node.js service and CLI alongside Herdr. Its web dashboard is served on localhost; remote access, if used, is through Tailscale.
- Reads Herdr workspaces, panes, agent states, and CodexBar quotas. Project orchestrators publish status files and read the current resource bulletin before dispatching workers.
- Uses local policy to set a global working-agent cap, provider management modes, harness and model availability, project shares and exclusions, idle borrowing, and handover thresholds.
- Gives each requesting project a recorded Chrome profile and debugging port. The existing signed-in shared browser on port 9222 is protected.
- Records worker runs and available measured token usage. Provider quota snapshots are a separate signal; they do not identify exact per-project consumption.
- Supports planned orchestrator handover through a fresh successor or session migration where conversion succeeds. A successor takes control only after its readiness is reviewed and activation is confirmed.

## Capabilities and Constraints

- Resource allocation between projects is advisory because project orchestrators retain control of their workers. The shared worker CLI enforces global dispatch limits and model exclusions at its own dispatch boundary, with authorized overrides for quota and capacity pressure.
- The user can choose to ignore pacing for a provider when speed or a particular harness matters more.
- Herdr Boss can terminate an orphaned agent-browser daemon under its safety rules. It does not terminate a running Chrome browser automatically.
- The dashboard and HTTP control API are local by default; the repository is public, while runtime state and browser profiles stay outside it.
- The supervisor itself is script-driven and consumes no model tokens. The Boss orchestrator is a separate agent whose provider also needs quota monitoring and a handover path.

## Evidence on Hand

- The repository contains the CLI and service in `src/`, the dashboard in `public/`, and the shared orchestrator kit in `kit/`.
- `README.md` describes current behavior and `docs/project-status.md` defines the published project status format.
- Live resource state and usage records are local runtime data. Published source code does not establish that quota pacing will always prevent exhaustion or that migration will succeed for every session.

## Product Principles

1. Preserve the orchestrator's ability to continue while keeping useful project work moving.
2. Give the user explicit controls for capacity, provider use, project priority, and exceptions.
3. Make resource advice visible and actionable; keep project orchestrators responsible for their own work decisions.
4. Keep shared machine resources attributable to projects and protect active browser sessions.
5. Distinguish measured project usage from inferred quota pressure, and retain enough history to evaluate the policy.
