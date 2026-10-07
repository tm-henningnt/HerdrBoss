# User guide

Choose the chapter for your task.

- [I want to see what is happening](guide/see.md)
- [I want to answer a question](guide/answer.md)
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

Run `herdr-boss tools check` to compare versions on this Mac and in the factory pins with public upstream releases. Add `--now` for a manual check. This command never upgrades a tool.

The check saves `tools-state.json` in the Herdr Boss data directory. `HERDR_BOSS_DIR` selects the directory. The default is `~/.herdr-boss`. The file has mode `0600` and contains no login or token data. Factory values come from the pin file. The command does not query running factories.

The check reports `late` when the first release after the tracked version is more than 14 days old. It reports `security` when a release note names a security issue or a CVE, a public advisory affects the tracked version, or the Debian security version is newer. It reports `unknown` when an upstream request fails. It keeps the last known latest version after a failed request. Run `herdr-boss doctor` to see one line for each late or security release. A late release is a note. A security release makes `doctor` exit 4.

For technical details, see the [Reference](reference/index.md). For commands, see the [CLI reference](cli.md).
