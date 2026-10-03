# Onboarding

This page describes how a new person gets from an empty folder to a running Herdr Boss. It has two parts. Part 1 is the main path, written for you. Part 2 is the design that the setup tools follow. Words in *italics* are in the [glossary](glossary.md).

## Part 1: The main path

You want an agent to set up Herdr Boss with you. You do not want to read a manual first.

WARNING: The agent never asks you for a password, a key, or a token. Never type one into the chat. The agent tells you where to put each secret.

### Start the agent in a new folder

1. Create a folder for Herdr Boss on your computer, for example `HerdrBossHome`.
2. Open the Terminal app and go to that folder.
3. Start Claude Code in the folder with `claude`. You can also start Codex with `codex`.
4. Give the agent this one instruction:

```text
Fetch https://raw.githubusercontent.com/tm-henningnt/HerdrBoss/main/docs/getting-started-prompt.md and follow it.
```

You should see the agent read the file. The file is the [Getting started prompt](getting-started-prompt.md). It tells the agent how to download Herdr Boss and how to guide you.

If the agent cannot fetch the file, open the link in your browser and paste the text into the agent.

### What the agent does first

1. The agent shows you the full path of the current folder.
2. The agent asks: "Do you want to put Herdr Boss in this folder?"
3. The agent waits for your answer. It downloads nothing before you say yes.
4. After your yes, the agent clones the public repository into a new `HerdrBoss` folder inside your folder.
5. The agent runs `herdr-boss doctor` in the new folder and starts the steps below.

You should see the new folder and the first `doctor` result. A green line means that an item is good. A red line has the exact fix.

If you answer no, the agent asks for another folder. If the download fails, the agent shows the error and stops.

### What the agent does and what only you do

The agent can:

- Run the checks.
- Install the *service* and the `herdr-boss` command, and open the *dashboard*.
- Add the Codex folder rules, with a backup.
- Create your first *project* after you name it.
- Install free Homebrew tools after you say yes.

Only you can:

- Sign in to Claude, ChatGPT, GitHub, and Tailscale.
- Buy a plan.
- Add the Claude settings lines.
- Type the computer password.
- Make a repository public.
- Handle a key or a token.

### Where each secret goes

When a step needs a secret, the agent names the place and stops. You do the step yourself.

| Secret | Where you put it |
|---|---|
| Claude sign-in | The browser page that `claude` opens. |
| ChatGPT sign-in for Codex | The browser page that `codex login` opens. |
| GitHub sign-in | The browser page that `gh auth login` opens. |
| Tailscale sign-in | The browser page that Tailscale opens. |
| Computer password | The password prompt of the Terminal app. The agent cannot see it. |
| Claude settings lines | `~/.claude/settings.json`, edited by you in an editor. |
| Any key or token | The private folder `~/.config/herdr-boss/`, or the tool that asks for it. Never a chat. |

## Part 2: The design

The tools of the first hour share one design. Later tasks build on it. This part lists the parts, the shared step names, and the rules.

### The parts

| Part | What it does | Task |
|---|---|---|
| `herdr-boss doctor` | Checks the computer. Reads only. | ONB1b |
| `herdr-boss setup` | Runs the steps. You can stop it and resume it. | ONB1c |
| Getting started prompt | Tells an agent how to guide you. | ONB1d |
| Get started page | Shows the `doctor` result and the setup progress in the dashboard. | ONB1e |
| Native Linux path | Makes `doctor`, `setup`, and `install` work on Linux. | ONB1g |

The main path of Part 1 starts the Getting started prompt. The terminal path runs `herdr-boss setup`. Both paths use the same steps.

### The shared step names

[Start here](start-here.md), `herdr-boss setup`, the Getting started prompt, and the dashboard Get started page use these names. Do not rename a step in one place only. Each step has a stable ID for `setup` and `--json` output.

| No. | Step name | ID | Who acts | `doctor` items that show it |
|---|---|---|---|---|
| 0 | Let an agent guide you | `guide` | You, then the agent | - |
| 1 | Check your computer | `check` | Agent | Operating system, disk, memory |
| 2 | Install the missing tools | `tools` | Agent, after your yes | Node, Git and the Git name, Herdr, `gh`, CodexBar, agent apps installed |
| 3 | Sign in to Claude | `signin` | Only you | Agent apps signed in |
| 4 | Let the agents work | `settings` | Only you | Claude `autoMode`, Codex rules, OpenCode worker profile |
| 5 | Start Herdr Boss | `service` | Agent | Service, data folder |
| 6 | Choose how to use your usage limits | `pacing` | You choose, agent saves | Usage reading |
| 7 | Create your first project | `project` | Agent, after you name it | - |
| 8 | Open the dashboard | `dashboard` | Agent opens it | Service answers |
| 9 | Answer your first question | `answer` | Only you | - |
| 10 | Review your first pack | `review` | Only you | - |

A step that differs on Linux has one "On Linux" line. A step that is only for a [factory](glossary.md) host, such as the Docker items, is outside the first hour.

### The rules for each tool

Each tool follows these rules.

1. No step asks for a password, a key, or a token. The step says where to put it.
2. The agent explains a step before it acts, and runs `doctor` after the step.
3. The agent never edits a protected setting and never works around a denial. It stops and asks when it is unsure.
4. Output has no host name, address, key, or private path. `doctor` masks the home folder.
5. Every step shows what you should see and what to do if you do not.

### `doctor`

`herdr-boss doctor` prints one line for each item: green or red, in plain words, with the exact fix. The option `--json` gives the same result to agents. The exit code is 0 when all is good and 4 when something needs a fix.

The items are: the operating system, Node, Git and the Git name, Herdr, each agent app (installed and signed in), `gh`, CodexBar, the service, the data folder, the settings lines, disk, and memory. Factory hosts add Docker and the Docker contexts.

### `setup`

`herdr-boss setup` is a wizard in the style of `project new`. Its steps are the shared steps. It exits with code 3 when a step waits for you, and it prints the instruction or adds a Mailbox item. Run it again to continue. It writes the pacing choice to the policy.

### The Getting started prompt

The file `docs/getting-started-prompt.md` holds the prompt. The command `herdr-boss setup --agent-prompt` prints the same text. The first version is for Claude Code. The Codex path uses the same text.

The prompt makes the agent do these things in order:

1. Show the folder and get your yes before it clones.
2. Read the docs and run `doctor --json`.
3. Ask you a few questions.
4. Do the shared steps one at a time, with an explanation before each step.
5. End with a summary and the next step.

### The Get started page

The page shows the `doctor` result as a checklist, the prompt with a copy button, and the setup progress. The checklist rows use the step names above.

### Which plan do I need?

You need one plan for one agent app. The costs are rough. Check the provider page for the current price.

| Plan | What it gives | Agent app | Rough cost each month |
|---|---|---|---|
| Claude Pro | Claude Code with a small usage limit. Enough for one project. | Claude Code | About 20 USD |
| Claude Max 5x | Five times the Pro usage limit. | Claude Code | About 100 USD |
| Claude Max 20x | Twenty times the Pro usage limit. For several projects. | Claude Code | About 200 USD |
| ChatGPT Plus | Codex with a small usage limit. Optional. | Codex | About 20 USD |
| ChatGPT Pro | Codex with a large usage limit. Optional. | Codex | About 200 USD |

Start with one Claude plan. Add Codex, OpenCode, and Pi later.

### Linux and Windows

On Linux, `doctor` and `setup` use the package manager of the system. `herdr-boss install` writes a systemd user service. CodexBar does not exist on Linux. [Linux usage reader](ideas/linux-usage-reader.md) describes how Herdr Boss reads the usage limits there. On Windows, you install Ubuntu under WSL2 and follow the Linux path inside it. The steps are in [windows-host.md](windows-host.md).

### The test run

A fresh agent that has only the prompt must reach a running Herdr Boss. The run uses a temporary `HOME` or a clean factory container. The Owner answers the questions of the agent in a review pack.

## Tasks that build on this design

| ID | Task | Needs |
|---|---|---|
| ONB1b | `herdr-boss doctor` | This page |
| ONB1c | `herdr-boss setup` | ONB1b |
| ONB1d | Getting started prompt and `setup --agent-prompt` | ONB1c |
| ONB1e | Dashboard Get started page | ONB1c |
| ONB1f | Guided setup test run | ONB1d, ONB1e, ONB1g |
| ONB1g | Native Linux path | ONB1c |
| ONB1h | Linux usage reader research | - |

The plan with all decisions is in [docs-and-onboarding.md](plans/docs-and-onboarding.md).
