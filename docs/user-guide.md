# User guide

Choose the chapter for your task.

Use Chat for ordinary messages. Use the Mailbox to answer, approve, or decide. A reply keeps the same conversation thread.

- [I want to see what is happening](guide/see.md)
- [I want to answer a Mailbox question](guide/answer.md)
- [I want to review a pack](guide/review.md)
- [I want to limit the cost](guide/cost.md)
- [I want to use it from my phone](guide/phone.md)
- [I want to add a project](guide/project.md)
- [I want to add a factory](guide/factory.md)
- [I want to move the head office](guide/factory.md#move-the-head-office)
- [I want to see the usage limits of a factory](guide/factory.md#sign-in-the-agent-apps-and-start-the-factory-boss)
- [Something went wrong](guide/trouble.md)

## Sign in to a site with a project browser

Project browsers run headless. Use the Browsers page to sign in without opening a Chrome window on the service machine.

1. Open the **Browsers** page in Herdr Boss.
2. For the project, select **Show preview**. Select the project browser screenshot to open the large view.
3. Enter the site's sign-in address. Select **Open sign-in tab**. The page opens in the project profile and turns on **Control browser**.
4. Use the page image to select each field. Type a password or code in the masked field above the image, then select **Send text**. Use the page image to select **Next** or **Sign in**.
5. Finish the sign-in steps in the image. The project browser keeps the login in its profile. A site can ask you to sign in again when the login expires.

Only the Owner can open a sign-in tab or send sign-in input from this view.

## Check tool versions

Run `herdr-boss tools check` to compare versions on this Mac and in the factory pins with public upstream releases. Every run checks upstream. This command never upgrades a tool. It uses public HTTPS endpoints and does not use your GitHub CLI login.

The check saves `tools-state.json` in the Herdr Boss data directory. `HERDR_BOSS_DIR` selects the directory. The default is `~/.herdr-boss`. The file has mode `0600` and contains version and risk data, but no login or token data. The command sets the directory mode to `0700` only when the directory is a real directory owned by the current user. Factory values come from the pin file. The command does not query running factories.

For GitHub releases, the check chooses the highest version on the tracked major line when that line has a release. Otherwise, it chooses the highest version overall. The check reports `late` when the first release after the tracked version is more than 14 days old. It reports `security` when a release note has a CVE ID or a GitHub advisory link with a GHSA ID, a public advisory affects the tracked version, or the Debian security version is newer. An advisory request failure does not discard good release data, but it can delay an advisory warning until the next check. A failed release request keeps the last known latest version and a saved `security` risk. Other saved risk values become `unknown`. Run `herdr-boss doctor` to see one line for each late or security release. A late release is a note. A security result older than 24 hours is ignored and doctor prints `note: tool check is stale, run herdr-boss tools check`. A fresh security release makes `doctor` exit 4.
## Manage factory project registrations

Run `herdr-boss project unregister <slug>` to remove a project from the registry. The command saves a registry backup first. It removes only the registry row. It leaves the project files, worktrees, and branches in place. It reports an error for an unknown slug.

A factory Boss skips a registered project outside the factory work volume. It does not trust that project or install kit files there. The start command prints a warning. `herdr-boss doctor` prints the same warning inside a factory. Use `project unregister <slug>` to remove the stale registration.

For technical details, see the [Reference](reference/index.md). For commands, see the [CLI reference](cli.md).
