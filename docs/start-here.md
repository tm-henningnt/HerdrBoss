# Start here

This page takes you from a new computer to a running Herdr Boss in about one hour. Do the steps in order. Each step tells you what you do, what you should see, and what to do if you do not see it. Words in *italics* are in the [glossary](glossary.md).

You need a Mac, [Claude Code](https://claude.com/claude-code), and one Claude plan. Codex, OpenCode, and Pi are optional *agent apps*. You can add them later.

On Linux, follow the lines that start with "On Linux". On Windows, first install Ubuntu under WSL2 with the steps in [windows-host.md](windows-host.md). Then follow the Linux lines inside Ubuntu.

WARNING: No step asks you for a password, a key, or a token. Never type one into a chat or a prompt. Each step says where to put it.

## Step 0: Let an agent guide you

This is the main path. You can also do the steps below by hand.

1. Download this repository to a folder on your computer.
2. Open Claude Code in that folder.
3. Paste the text from [getting-started-prompt.md](getting-started-prompt.md).

You should see the agent ask you a few questions. Then it explains each step before it does the step. After each step it runs `herdr-boss doctor`.

If you prefer the terminal, run `herdr-boss setup`. It has the same steps. It stops when a step waits for you. Run it again to continue.

## What the agent does and what only you do

The agent can:

- Run the checks.
- Install the service and the `herdr-boss` command, and open the dashboard.
- Add the Codex folder rules, with a backup.
- Create your first project after you name it.
- Install free Homebrew tools after you say yes.

Only you can:

- Sign in to Claude, ChatGPT, GitHub, and Tailscale.
- Buy a plan.
- Add the Claude settings lines.
- Type the computer password.
- Make a repository public.
- Handle a key or a token.

## Step 1: Check your computer

1. Open the Terminal app.
2. Go to the downloaded folder.
3. Run `bin/herdr-boss doctor`.

You should see one line for each item. A green line means the item is good. A red line has the exact fix.

If a line is red, do the fix that it prints. Run `doctor` again.

## Step 2: Install the missing tools

1. Install each tool that `doctor` shows in red. `doctor` prints the exact command.
2. Run `bin/herdr-boss doctor` again.

You should see no red line for a missing tool. The tools are Node, Git, Herdr, and the agent app that you use. `gh` and CodexBar are optional.

If a tool does not install, ask the agent from step 0 for help.

On Linux, install the tools with the package manager of your system. `doctor` names the tool. CodexBar does not exist on Linux, so the usage reading from it is not available.

## Step 3: Sign in to Claude

1. Run `claude` in the Terminal.
2. Follow the sign-in page that opens in the browser.
3. Sign in with your own Claude account.

You should see Claude Code start with no sign-in request. Only you do this step.

If the browser does not open, copy the address from the Terminal into your browser. Never paste the sign-in code into a chat.

## Step 4: Let the agents work

Claude Code stops and asks you before many actions. Herdr Boss agents need some settings so that they can do routine work without a question. Only you add these settings lines. An agent cannot edit this file.

1. Run `bin/herdr-boss harness sync`. It prints the lines that are missing.
2. Make a backup: `cp ~/.claude/settings.json ~/.claude/settings.json.bak`.
3. Open `~/.claude/settings.json` in an editor.
4. Add each missing line to the `autoMode` part of the file. The full steps are in [harness-setup.md](harness-setup.md).
5. Start a new Claude Code session.

You should see no missing line when you run `herdr-boss harness sync` again. If the file is not valid after your edit, copy the backup back and try again.

## Step 5: Start Herdr Boss

1. Run `bin/herdr-boss install`.
2. Link the command: `ln -s "$(pwd)/bin/herdr-boss" ~/.local/bin/herdr-boss`.
3. Run `herdr-boss doctor`.

You should see that the *service* runs. The command `install` starts it. It runs in the background and starts again when you sign in.

If `doctor` says that the command is not found, add `~/.local/bin` to your `PATH`. On Linux, `install` writes a systemd user service.

## Step 6: Choose how to use your usage limits

A *paced* *provider* spreads its use evenly over the *limit window*. Herdr Boss holds back new work when you are ahead of the pace. This protects the rest of the week.

1. Open the dashboard Settings page. Step 8 shows how to open it.
2. For each provider, choose **Manage pace** or **Ignore usage limit**.
3. Choose **Manage pace** when you want to keep usage for the whole week. Choose **Ignore usage limit** when you want the agents to use all of it.

You should see your choice saved on the page.

## Step 7: Create your first project

A *project* is one product that you build with agents. Herdr Boss makes the folder, the files, and the *project lead*.

1. Run `herdr-boss project new <name> --start`.
2. Enter a goal in one line when it asks, or add `--goal "<text>"`.
3. Choose a private repository when it asks about a remote.

You should see one line for each step and the path of the project. The project lead starts in its own pane.

If a step fails, run the same command again with `--resume`. The command `--start` uses your usage limit.

## Step 8: Open the dashboard

1. Open `http://127.0.0.1:4477` in your browser.

You should see the *Overview*. It lists your project and its project lead. On your own computer you do not need to sign in.

If the page does not load, run `herdr-boss doctor`. The line for the service tells you what to do.

## Step 9: Answer your first question

The project lead asks you a question when it cannot decide. The question appears in the *Mailbox* under "Needs you".

1. Open the Mailbox.
2. Read the first item under "Needs you".
3. Choose an answer or write one.

You should see the item leave the list. The project lead continues its work.

If the list is empty, open the *Chat* and ask the Boss what the project lead does now.

## Step 10: Review your first pack

A *review pack* is a set of *items* with evidence. You accept, reject, or comment on each item. A project lead sends a pack when it has finished a part of the work.

1. Open the Mailbox when a pack arrives.
2. Open the pack.
3. Judge each item. Open a *live check* when the item has one.
4. Submit your answers.

You should see the project lead receive your result and start the next task.

## Next

- [Concepts](concepts.md), [user guide](user-guide.md), [glossary](glossary.md), and [Reference](reference/index.md).
