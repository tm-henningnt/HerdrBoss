# Use it from your phone

This chapter shows how to open the *dashboard* on your phone, how to add it to the home screen, and how to answer questions on a small screen. Words in *italics* are in the [glossary](../glossary.md). The other chapters of the [user guide](../user-guide.md) cover the dashboard pages.

WARNING: The sign-in token gives full control of your agents. Never type it into a chat or a prompt. Never send it in a message.

## Reach the dashboard from your phone

*Tailscale* is a free network tool. It joins your phone and your computer in one private network. Traffic between them is encrypted.

What you do:

1. Install the Tailscale app on your computer and on your phone.
2. Sign in to Tailscale on both devices with the same account. Only you do this step.
3. Find the name of your computer in the Tailscale app on the phone.
4. Open `http://<computer-name>:4477` in the phone browser. Replace `<computer-name>` with that name.
5. Copy the token on your computer. Run `pbcopy < ~/.config/herdr-boss/access-token` in the Terminal app. The command prints nothing.
6. Send the copied text to the phone with Universal Clipboard, or paste it into your password manager. Then paste it into the sign-in form.

On Linux, copy the token with the clipboard tool of your system. Do not print the file in a terminal that an agent can read.

What you should see: the sign-in form first, then the *Overview*. The session lasts 30 days. A password manager can save the token for the next sign-in.

If you do not see it:

- If the page does not load, check that Tailscale shows both devices as connected.
- If the page still does not load, run `herdr-boss doctor` on the computer. The line for the *service* tells you what to do.
- If the form refuses the token, copy the token again. A new token signs out all devices.
- If the browser says the host name is not allowed, add the name in Settings, under Advanced, in the Service settings, as an allowed host.

## Add the dashboard to the home screen

What you do:

1. Open the dashboard in Safari on the phone.
2. Tap the Share button.
3. Tap **Add to Home Screen**.
4. Tap **Add**.

What you should see: an icon on the home screen. A tap on it opens the dashboard full screen.

If you do not see it: use Safari. Another browser can lack the **Add to Home Screen** choice. If the icon opens a sign-in form, sign in again with the token.

## Use the Mailbox and the Chat on the phone

You want to answer a question while you are away.

What you do:

1. Tap the Herdr Boss logo at the top left.
2. Tap **Mailbox**. Tap the logo to open the shared menu. Select **Needs you**.
3. Tap an item. Choose an answer or write one.
4. Tap the Chat icon in the app bar to talk with the Boss.

What you should see: the same menu has every section. This includes **Fleet** and **Docs**. On Mailbox pages, it also has the Mailbox folders. The Herdr Boss logo opens the menu on every phone page. Each page fits the screen width. Tables show stacked rows. Each button is at least 44 px high. A review pack opens as a full page.

The Mailbox and Chat update while they are open. If you switch apps or lose the network, they refresh when the page becomes visible or the network returns.

If you do not see it:

- If the page scrolls sideways, reload it. A wide table scrolls inside its own box.
- If a warning line shows under the header, check Tailscale. The page retries its reads after the connection returns.
- If the screen zooms when you tap a field, update your phone software. The fields use a 16 px font to prevent this.
