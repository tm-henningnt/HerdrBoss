# Herdr Boss

Herdr Boss supervises the orchestrator agents that run in [Herdr](https://herdr.dev). It watches subscription quotas and machine resources, tells orchestrators when to change how they work, and serves one dashboard for all projects. It also holds the shared orchestration kit: the worker CLI, the orchestrator skill, and the brief templates.

Herdr Boss is a script. It uses no LLM and no tokens.

## Requirements

| Software | Needed for |
|---|---|
| Node 22+ | Everything. |
| [Herdr](https://herdr.dev) CLI | Agents, panes, notices, workers, and handover. |
| CodexBar CLI | Quota readings and pacing. |
| Git | Worker worktrees. |
| Codex, Claude, OpenCode, or Pi CLI | The harnesses that you make available. |
| Google Chrome (optional) | Project browsers. |
| `session-migrate` (optional) | Handover with the conversation history. |
| GitHub CLI `gh` (optional) | The kit's issue commands. |
| Roamgate, Tailscale (optional) | A dashboard link to Roamgate; remote access from a tailnet. |

## Install

1. Run `bin/herdr-boss install`. This installs and starts the macOS launchd agent.
2. Link the CLI: `ln -s "$(pwd)/bin/herdr-boss" ~/.local/bin/herdr-boss`, with `~/.local/bin` on your `PATH`.
3. Open http://127.0.0.1:4477.
4. Label each orchestrator pane `orch`: `herdr pane rename <pane-id> orch`.

To remove the service, run `bin/herdr-boss uninstall`. On other systems, run `herdr-boss serve`.

## Documentation

- [User guide](docs/user-guide.md): how it works, rules, configuration, remote access, handover, and browsers.
- [CLI reference](docs/cli.md): every command and option.
- [Project status files](docs/project-status.md): what orchestrators publish for their project page.
- [Orchestrator instructions](docs/orchestrator-instructions.md): add the shared rules to a project.
- [Orchestrator skill](kit/skills/herdr-orchestrator/SKILL.md) and [browser service](kit/browser-service.md): the shared kit for agents.

The dashboard has a **Help** panel on each page.
