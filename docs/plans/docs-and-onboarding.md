# Docs and onboarding plan (DOC1 and ONB1)

This plan tells the writers and the workers how to rewrite the docs (DOC1) and how to build the first-hour setup (ONB1). The Owner answered review packs `docs-onboarding-r1` and `docs-onboarding-r2` in planning session `ps-ff59baa2`.

## Decisions

| ID | Decision | Source |
|---|---|---|
| D1 | The reader builds products with coding agents. The reader is not a programmer or an administrator. The reader can follow a checklist, copy a command, and read a status page. | Owner, r1 `audience-voice` |
| D2 | All docs keep ASD-STE100. Use plain words, "you" for the reader, and one idea in each sentence. Explain each new word where it first appears, and link it to the glossary. | Owner, r1 `audience-voice` |
| D3 | README first screen: a short text, a list of what you get, one picture of how the parts fit, then the link to Start here. | Owner, r1 `readme-first-screen` |
| D4 | README screenshots: the Overview on a desktop, the Mailbox "Needs you" on a phone, and a review pack on a phone. Each has a light and a dark version. Use invented sample projects only. | Owner, r1 `readme-screenshots` |
| D5 | Say "project lead" in the docs and the dashboard text. Commands, the pane label `orch`, API fields, and the Reference keep "orchestrator". | Owner, r1 `word-orchestrator` |
| D6 | Use the vocabulary table below. | Owner, r1 `words-other` |
| D7 | Technical detail moves to a separate Reference part. | Owner, r1 `hide-from-newcomers` |
| D8 | The user guide has eight chapters, one for each job. | Owner, r1 `guide-jobs` |
| D9 | The first hour starts from a Mac, Claude Code, and one Claude plan. Codex, OpenCode, and Pi are add-ons. | Owner, r1 `onb-start-kit` |
| D10 | The guided agent (the Getting started prompt) is the main path. `herdr-boss setup` is the alternative for terminal users. | Owner, r1 `onb-main-path` |
| D11 | The "only you" line in the ONB1 section below. | Owner, r1 `onb-only-you` |
| D12 | Length limits: README 120 lines, Start here 150, concepts 150, glossary one line for each word, each guide task 60, Reference no limit. A test enforces them. | Owner, r1 `doc-lengths` |
| D13 | The Owner reviews twice: a tone pack (README, Start here, glossary) before the guide chapters, then the full result with before and after and one guided setup test run. | Owner, r1 `review-order` |
| D14 | The Mac stays the first path. Add a native Linux path: `doctor`, `setup`, and the service learn Linux (a systemd user service). Windows users run the Linux path inside Ubuntu under WSL2. The Codex CLI has a Linux version, and the factories use it. Linux has no CodexBar: a research task finds the Linux usage reader. | Owner, r2 `windows-linux` |
| D15 | Add a theme switch in the menu: Device, Light, Dark. Device is the default. The browser remembers the choice. A separate task, outside the docs work. | Owner, r2 `theme-switch` |
| D16 | `docs/cli.md`, `docs/harness-setup.md`, `docs/windows-host.md`, and `docs/factory-host-runbook.md` keep their paths. The kit and agents cite them. The Reference index links to them. | Planner |
| D17 | The guide has one file for each chapter in `docs/guide/`. `docs/user-guide.md` becomes a short index with the eight chapters and the Reference link. | Planner |
| D18 | The concepts page uses Mermaid diagrams, so that GitHub draws them from text. | Planner |
| D19 | Start here, `herdr-boss setup`, the Getting started prompt, and the dashboard Get started page use the same step names. The host guide in the docs uses the step names of the "Add a host" page (ticket 22). | Planner |
| D20 | The docs and the host guide cover each of the 15 host items (H1 to H15) with its check. A test fails when an item is missing. | Boss, through the orchestrator |
| D21 | No setup step asks for a password, a key, or a token. It says where to put it. No doc holds a host name, an address, a key, or a client name. | Boss task, repository rule |

## Vocabulary

User docs and dashboard text use the left column. The Reference and the commands keep the right column. The glossary row names both.

| Word in user docs | Word in commands and Reference | Plain meaning |
|---|---|---|
| Boss | Boss | The one agent that watches all projects and talks to you. |
| project lead | orchestrator (`orch`) | The agent that leads the work of one project. |
| worker | worker | An agent that does one task for a project lead. |
| factory | factory | One complete Herdr Boss setup on one computer or container. |
| review pack | review pack | A set of items with evidence that you judge one by one. |
| usage limit | quota | The part of your subscription that you can use in a time window. |
| paced | paced | A paced provider spreads its use evenly over the limit window. |
| handover | handover | A fresh agent takes over the work of a project lead. |
| planning session | planner session | An agent plans with you through review packs. |
| Watch | watch | The Boss acts for you while you are away. |
| agent app | harness | Claude Code, Codex, OpenCode, or Pi. |
| (hidden) | bulletin, ledger, lease, lock | Internal. Reference only. |

## README (120 lines at most)

1. Title and the three-sentence text (r1 draft).
2. "What you get": six bullets (agents for each project, dashboard on the phone, questions only when needed, review packs, usage under control, several computers).
3. The picture (Mermaid): you, the dashboard, the Boss, one project lead for each project, workers, factories.
4. "Start here" link to `docs/start-here.md`.
5. Three screenshots with captions, in light and dark (`<picture>` with `prefers-color-scheme`).
6. "What you need": a Mac, Claude Code, a Claude plan. One line: Linux works too, and Windows works through Linux in WSL2 (D14).
7. "More": links to concepts, the user guide, the glossary, the Reference.

The README has no ports, no service details, and no command list.

## Start here (`docs/start-here.md`, 150 lines at most)

A checklist with one step for each heading. Each step has: what you do, what you should see, and what to do if not. The step names are the shared names of D19:

1. Check your computer (`herdr-boss doctor`).
2. Install the missing tools.
3. Sign in to Claude.
4. Let the agents work (the settings lines that only you add).
5. Start Herdr Boss.
6. Choose how to use your usage limits (paced or not).
7. Create your first project.
8. Open the dashboard.
9. Answer your first question.
10. Review your first pack.

Step 0 says: open Claude Code in the downloaded folder and paste the Getting started text (D10). The steps then show what the agent does and what only you do.

A step that differs on Linux has one "On Linux" line. On Windows, the reader first installs Ubuntu under WSL2 with the first host guide steps, then follows the Linux lines (D14).

## Concepts (`docs/concepts.md`, 150 lines at most)

One short section and one Mermaid diagram for each concept: the Boss, project leads, workers, factories, review packs, usage limits and pacing, handovers, Watch. Each section links to its guide chapter.

## Glossary (`docs/glossary.md`)

One line for each word: the plain word, the command word when it differs, and the meaning. About 40 words. `docs/CONTEXT.md` stays the factories glossary for agents and links to `docs/glossary.md`.

## User guide (`docs/guide/`, 60 lines for each task)

Each task has three parts: "What you do", "What you should see", "If it does not work".

1. `see.md`, I want to see what is happening: read the Overview; follow one project (project page, Board); see what each agent does (Agents); see the cost (Analytics); let the Boss act while you are away (Watch).
2. `answer.md`, I want to answer a question: answer in the Mailbox; talk in the Chat; send a picture; get messages on the home screen.
3. `review.md`, I want to review a pack: open a pack; judge an item; ask for a live check; submit; what happens next.
4. `cost.md`, I want to limit the cost: read the usage limits; pace a provider; set the number of workers; share workers between projects (Allocation); turn off a model or an agent app; plan around a limit reset; let a fresh agent take over (handover).
5. `phone.md`, I want to use it from my phone: reach the dashboard from the phone (Tailscale); add it to the home screen; use the Mailbox and the Chat on the phone.
6. `project.md`, I want to add a project: create a project (the wizard); start the project lead; give it a goal; add a second agent app.
7. `factory.md`, I want to add a factory: what a factory is; prepare a host (Windows with WSL2, Linux, Mac with OrbStack); create and start a factory; sign in the agent apps; start the factory Boss; join the Fleet page; update a factory.
8. `trouble.md`, something went wrong: the usage reading failed; an agent waits for permission; a worker stopped; a host is unreachable; the dashboard does not load; a project browser is stuck; the usage reading is missing on Linux.

## Reference (`docs/reference/`)

`index.md` lists each Reference file. The technical sections of today's `docs/user-guide.md` move here word for word, by topic: `service.md` (how it works, data directory, configuration, usage records), `api.md` (HTTP API, Chat API, review pack API), `dashboard.md` (page details), `settings.md` (settings and allocation, rules and notices), `handover.md`, `browsers.md`, `factories.md` (factory hosts, container factories, Fleet), `locks.md` (leases, locks, memory classes, denials). The index also links the files of D16.

## Factory host coverage

Chapter 7 links to the "Add a host" page (ticket 22) and to `docs/windows-host.md`. Both use the 25 step names of the Owner's reference, in order: BIOS; update Windows; never sleep; active hours; install WSL; install Ubuntu; turn on systemd; limit memory and CPU; add the Docker repository; install Docker; configure and test Docker; put the Mac on Tailscale; turn on MagicDNS and HTTPS; write the access policy; install Tailscale in Ubuntu; make the SSH key on the Mac; add the public key to Ubuntu; install the SSH server; let SSH start after Tailscale; tell the Mac which key to use; create the boot task; test from the Mac; reboot test; collect the machine facts; answers and table.

The 15 host items go into these steps. Each has a check that the guide shows:

| ID | Step text (plain) | Check that the guide shows |
|---|---|---|
| H1 | WSL never stops when idle: `.wslconfig` sets `instanceIdleTimeout=-1` and `vmIdleTimeout=-1`, memory, processors, swap, and `autoMemoryReclaim`. Run `wsl --shutdown` to apply. | Close all WSL windows. Wait 3 minutes. `wsl -l -v` still shows Running. |
| H2 | The boot task runs as your own Windows account, also when you are signed out. It has two triggers: at startup, and every 5 minutes with no end. It never starts a second copy and has no time limit. | `wsl --terminate <distro>`. Wait 5 minutes. The host answers again. |
| H3 | With remote desktop, disconnect. Never sign out. Windows 10 22H2 has no support: use it for tests only. | The guide warns before the remote desktop step. `doctor` warns on Windows 10. |
| H4 | Optional: mask `systemd-binfmt.service`, so that systemd reports running. | `systemctl is-system-running` shows running, or degraded with only that unit failed. |
| H5 | Tailscale runs inside Ubuntu, with its own name and address. The machine has `tag:factory` and key expiry off. | The admin console shows the tag and "expiry disabled". The host answers on its tailnet name. |
| H6 | Give the factory user the operator right (`tailscale set --operator=factory`). Turn on Serve for the tailnet. | `tailscale serve status` prints "no serve config" without sudo. |
| H7 | The access rules let the Mac reach `tag:factory` on ports 22, 4477, and 4478, with rule tests for each port. | `nc -vz <host> 4478`: "refused" means reached; a timeout means the rule is missing. |
| H8 | MagicDNS and HTTPS certificates are on. | The tailnet name of the host resolves on the Mac. |
| H9 | One SSH key for each host, in a Mac folder that agents cannot read. The public key goes into `authorized_keys` of the Ubuntu factory user. The SSH server takes keys only and starts after Tailscale. | `sudo sshd -T` shows `passwordauthentication no`. Key login works after a reboot. |
| H10 | A Docker context on the Mac for each host (`hf-<name>`). | `docker --context hf-<name> ps` works without a password. |
| H11 | The factory user is in the docker group. Docker log rotation is on. | `docker info` shows the WSL memory limit. |
| H12 | Docker safety: no prune or remove commands on a shared daemon, a label on each resource, one buildx builder for each host. | The guide shows the rule before the first Docker command. |
| H13 | The code volume: git runs as the factory user, an `origin` remote exists, updates are fast-forward. | `herdr-boss factory update <name> --tier service` passes. |
| H14 | Sign in each agent app for each factory at the host terminal. Never paste a token in a chat. Start the factory Boss. | `factory login <name> <app>` and `factory boss start <name>` pass. |
| H15 | Join the Fleet page. Run connect again when the read credential is missing at first. | `factory connect --check <name>` shows the factory, and the Fleet page lists it. |

## ONB1 design summary

- **`herdr-boss doctor`** checks the computer and reads only. One line for each item: green or red, in plain words, with the exact fix. Items: the operating system, Node, Git and the Git name, Herdr, each agent app installed and signed in, `gh`, CodexBar, the service, the data folder, Docker and contexts (factories only), the settings lines (Claude `autoMode`, Codex rules, the OpenCode worker profile), disk, and memory. `--json` for agents. Exit 0 when all is good, exit 4 when something needs a fix. It masks the home folder and prints no secret.
- **`herdr-boss setup`** is a wizard that you can stop and resume, in the style of `project new`. Its steps are the Start here steps. It exits 3 when a step waits for you, with a printed instruction or a Mailbox item. It writes the pacing choice to the policy.
- **The Getting started prompt** (`docs/getting-started-prompt.md`, also printed by `herdr-boss setup --agent-prompt`). The first version is for Claude Code (D9). The agent reads the docs, runs `doctor --json`, interviews you, explains each step before it acts, and runs `doctor` after each step. It ends with a summary and the next step. Its rules: never ask for a secret, never edit protected settings, never work around a denial, and stop and ask when unsure.
- **The "only you" line (D11).** The agent may run the checks, install the service and the command, open the dashboard, add the Codex folder rules (with a backup), create the first project after you name it, and install free Homebrew tools after you say yes. Only you sign in to Claude, ChatGPT, GitHub, and Tailscale. Only you buy a plan, add the Claude settings lines, type the computer password, make a repository public, and handle a key or a token.
- **"Which plan do I need?"**: a table of each plan, what it gives, the rough monthly cost, and the agent app that uses it.
- **The Get started page** in the dashboard shows the `doctor` result as a checklist, the prompt with a copy button, and the setup progress.
- **The test run**: a fresh agent with only the prompt reaches a running Herdr Boss in a temporary `HOME` or a clean factory container. The Owner answers its questions in a review pack.

## Work breakdown

Each worker writes in ASD-STE100 and uses the vocabulary table. "Prose" means `claude`. Each task lists its allowed paths.

| ID | Task | Kind and model | Allowed paths | After |
|---|---|---|---|---|
| DOC1a | Glossary and the CONTEXT link | claude, claude-opus-5-5 | `docs/glossary.md`, `docs/CONTEXT.md` | - |
| DOC1b | README with picture and screenshots (seeded preview, light and dark) | claude, claude-opus-5-5 | `README.md`, `docs/images/readme/` | DOC1a |
| DOC1c | Start here | claude, claude-opus-5-5 | `docs/start-here.md` | DOC1a |
| DOC1d | Owner tone pack (D13, pack 1): README, Start here, glossary | orchestrator | - | DOC1b, DOC1c |
| DOC1e | Move the technical sections to the Reference word for word; make `docs/user-guide.md` an index; fix links | codex, gpt-6-luna | `docs/user-guide.md`, `docs/reference/`, links in `docs/` | DOC1a |
| DOC1f | Concepts with Mermaid diagrams | claude, claude-sonnet-5-5 | `docs/concepts.md` | DOC1d |
| DOC1g | Guide chapters 1 to 4 | claude, claude-sonnet-5-5 | `docs/guide/see.md`, `answer.md`, `review.md`, `cost.md` | DOC1d, DOC1e |
| DOC1h | Guide chapters 5 to 8, with H1 to H15 in chapter 7 and `docs/windows-host.md` | claude, claude-sonnet-5-5 | `docs/guide/phone.md`, `project.md`, `factory.md`, `trouble.md`, `docs/windows-host.md` | DOC1d, DOC1e |
| DOC1i | Dashboard words: HELP, page titles, and labels use the user-docs words | claude, claude-sonnet-5-5 | `public/app.js`, `public/setting-help.js`, `test/` | DOC1a |
| DOC1j | Doc tests: length limits (D12), links, host coverage (H1 to H15 and the 25 step names), and a private-value scan | codex, gpt-6-luna | `test/docs-*.test.js` | DOC1h |
| DOC1k | Command and path check: each command, option, path, and route in the docs exists | codex, gpt-6.1-sol, review only | report only | DOC1g, DOC1h |
| DOC1l | Reader test and fix rounds (see below) | orchestrator subagent, then claude-sonnet-5-5 for fixes | docs of the finding | DOC1k |
| DOC1m | Owner result pack (D13, pack 2) | orchestrator | - | DOC1l, ONB1f |
| ONB1a | `docs/onboarding.md`: the design, the shared step names, the plan table | claude, claude-opus-5-5 | `docs/onboarding.md` | DOC1d |
| ONB1b | `herdr-boss doctor` | codex, gpt-6.1-sol | `src/doctor.js`, `src/cli.js`, `test/doctor*.test.js`, `docs/cli.md` | ONB1a |
| ONB1c | `herdr-boss setup` | codex, gpt-6.1-sol | `src/setup*.js`, `src/cli.js`, `test/setup*.test.js`, `docs/cli.md` | ONB1b |
| ONB1d | Getting started prompt and `setup --agent-prompt` | claude, claude-opus-5-5 | `docs/getting-started-prompt.md`, `src/setup*.js`, `test/` | ONB1c |
| ONB1e | Dashboard Get started page | claude, claude-sonnet-5-5 with Impeccable | `public/`, `src/server.js`, `test/` | ONB1c |
| ONB1f | Guided setup test run in a temporary `HOME` or a clean factory container | claude, claude-sonnet-5-5 | `.worker/` | ONB1d, ONB1e, ONB1g |
| ONB1g | Native Linux path: `doctor` and `setup` on Linux, `herdr-boss install` writes a systemd user service | codex, gpt-6.1-sol | `src/doctor.js`, `src/setup*.js`, `src/install*.js`, `src/cli.js`, `test/`, `docs/cli.md` | ONB1c |
| ONB1h | Research: how to read the usage limits on Linux without CodexBar (Codex CLI, Claude Code); a short report with options | claude, claude-sonnet-5-5, research only | `docs/ideas/linux-usage-reader.md` | - |
| THEME1 | Theme switch in the menu: Device, Light, Dark; HELP and docs | claude, claude-sonnet-5-5 | `public/`, `test/`, `docs/guide/see.md` | - |

The test in DOC1j also reads the step list of the "Add a host" page when ticket 22 adds it. It fails when one of H1 to H15 is missing from the steps.

ONB1g extends ONB1b and ONB1c. ONB1h and THEME1 do not block the docs.

## Order

1. DOC1a, then DOC1b and DOC1c side by side. DOC1e and DOC1i can start after DOC1a.
2. DOC1d: the Owner's tone pack. Change README, Start here, and glossary until accepted.
3. DOC1f, DOC1g, DOC1h, and ONB1a side by side. Then DOC1j and DOC1k.
4. ONB1b, ONB1c, then ONB1d, ONB1e, and ONB1g side by side, then ONB1f. ONB1h and THEME1 run in any free slot.
5. DOC1l, then DOC1m.

## Reader test

A subagent plays the reader of D1. It gets only the README, Start here, the glossary, and one guide task at a time. It lists each word that it does not know, each step that it cannot follow, and each step without a "what you should see". A writer fixes each finding. The test runs again until the list is empty. A second run checks the dashboard help panels against the glossary.

## Block for `docs/orchestration/memory.md`

```
- 2026-10-03: DOC1 and ONB1 plan (Owner, review packs docs-onboarding-r1 and r2, session ps-ff59baa2): docs/plans/docs-and-onboarding.md. Reader: people who build products with agents, not programmers. All docs keep ASD-STE100 in a plain "you" voice. README: text, picture, Start here link; screenshots Overview (desktop), Mailbox Needs you (phone), review pack (phone), light and dark, invented data. Words in docs and dashboard: "project lead" (commands keep orchestrator and `orch`), "usage limit" (Reference keeps quota), "agent app" (Reference keeps harness), "planning session"; Boss, worker, factory, review pack, handover, paced, Watch stay. Technical detail moves to docs/reference/; docs/cli.md keeps its path. Guide: eight job chapters in docs/guide/. Limits: README 120, Start here 150, concepts 150, guide task 60 lines; a test enforces them. First hour: Mac, Claude Code, one Claude plan; add a native Linux path (doctor, setup, systemd user service), Windows through Linux in WSL2, and research a Linux usage reader; add a Device, Light, Dark theme switch; the guided agent prompt is the main path, herdr-boss setup the alternative. Only the Owner signs in, buys plans, adds Claude settings lines, types the computer password, makes a repo public, and handles keys and tokens. Two Owner packs: a tone pack, then the full result with a guided setup test run. The docs and the host guide cover the 15 host items H1 to H15 with checks, and a test enforces it.
```
