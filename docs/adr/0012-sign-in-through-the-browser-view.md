# ADR 0012: Browser sign-in uses the existing dashboard browser view

Status: Accepted. Decided by the planner in the factories interview, round 2. Follows ADR 0010.

## Context

ADR 0010 requires a route for the Owner to sign in to a web app in the headless Chrome of a container factory. The dashboard already shows a project browser and forwards input. `src/server.js` serves the browser screenshot, navigation, and `/input` routes (click, text, key). `src/browser-preview.js` drives them with `Page.captureScreenshot`, `Input.dispatchMouseEvent`, and `Input.dispatchKeyEvent`. The Chrome path is fixed to the macOS path in `src/browser-pool.js:410` and `src/clone-sweep.js:9`.

## Decision

- Use the existing dashboard browser view, screenshot polling, and `/input` route as the sign-in route of a container factory. The Owner opens the factory dashboard on its own hostname and signs in there.
- Make the Chrome path a setting, with the Linux path as the image default.
- Add a sign-in task to the browser view: open a URL in the project profile, show the frames, and forward keys, text, and modifier keys. Test it with a password field and a one-time code field.
- The login stays in the per-project Chrome profile on the `home` volume.
- Add `Page.startScreencast` only if the polling view is too slow for a sign-in.

## Consequences

- No VNC server, X server, or noVNC in the image.
- The sign-in route has the same access rules as the dashboard. Only the owner role may use it (spec section 17.3).
- A password manager on the Owner's device does not fill the remote field. The Owner types or pastes the password.

## Alternatives rejected

- Xvfb, a VNC server, and noVNC in the image. A larger image, a second remote-control surface, and a second access path to secure.
- A `Page.startScreencast` view from the start. It adds a streaming channel before the need is shown.
