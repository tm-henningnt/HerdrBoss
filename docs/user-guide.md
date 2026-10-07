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

## Disk use

Run `herdr-boss worktree disk` from a project repository to see the size of each worktree, the total, and free space. Add `--json` for a JSON report.

Run `herdr-boss worktree prune --clean-build` to list rebuildable output in worktrees that the prune keeps. Add `--apply` to delete it. The command skips tracked files, `node_modules`, the primary checkout, and worktrees with a live pane or running process. It removes only `dist`, `.vite`, `test-results`, and screenshots older than one day from `.worker/tmp`.

The Doctor disk line reports free space at the Herdr Boss data folder and the configured worktree root. It uses the lower value when they are on different file systems. It gives a note below 15 GB. It gives an error below 5 GiB.

When the main checkout has `node_modules` and all detected lock files match the new worker worktree, `worker start` uses a copy-on-write clone on macOS. It uses the setup command or `npm ci` when the lock files differ or the clone fails.

For technical details, see the [Reference](reference/index.md). For commands, see the [CLI reference](cli.md).
