# Boss dashboard direction

Mode: Operate.

The owner should understand the state of their project fleet within one viewport, act on urgent resource or continuity issues, and then move to focused controls or history without scrolling through unrelated sections.

## Structure

- Overview (`/`): concise capacity, actionable attention, suggested and prepared handovers, and a compact project roster. Abbreviated subscription and machine bars sit at the bottom. One subscription expander reveals all provider quota windows together; machine health folds out to processes and history. The first viewport must answer: Is anything urgent? Which project or provider is affected? What can I do now?
- Allocation (`/allocation`): the existing policy controls and dedicated browser requests, grouped by capacity, subscriptions, and project shares. The save state stays visible while editing.
- Agents (`/agents`): live Herdr workspaces and agents.
- Analytics (`/analytics`): actual recorded worker usage and measurement coverage by project and provider, plus recent runs. State empty coverage honestly until orchestrators record data.
- Logs (`/logs`): current guidance and Boss activity.
- Project detail (`/p/<slug>`): preserve each published task board and live agents, with a route back to Overview. Every open workspace has a page and can plan a handover even without a quota alert or published status.

## Interaction

A suggested or manually initiated handover offers Plan, Prepare, inspect successor output, and Confirm activation in that order. Preparing creates a successor but leaves the source pane in control. The UI must show migration failure and a fresh bootstrap choice. Activation requires an explicit confirmation after the user can read the successor's output.

## Visual continuity

Preserve the incumbent light and dark palettes, restrained orange action accent, typography, and compact operational tone. Use clearer hierarchy, tables, and whitespace to reduce repeated cards and long alert prose. Do not invent status or consumption evidence.
