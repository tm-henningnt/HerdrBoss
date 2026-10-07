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

## Manage factory project registrations

Run `herdr-boss project unregister <slug>` to remove a project from the registry. The command saves a registry backup first. It removes only the registry row. It leaves the project files, worktrees, and branches in place. It reports an error for an unknown slug.

A factory Boss skips a registered project outside the factory work volume. It does not trust that project or install kit files there. The start command prints a warning. `herdr-boss doctor` prints the same warning inside a factory. Use `project unregister <slug>` to remove the stale registration.

For technical details, see the [Reference](reference/index.md). For commands, see the [CLI reference](cli.md).
