# Boss dashboard direction

Mode: Operate.

The owner should understand the state of their project fleet within one viewport, act on urgent resource or continuity issues, and then move to focused controls or history without scrolling through unrelated sections.

## Structure

- Overview (`/`): concise capacity and quota status, actionable attention, staged handovers, and a compact project roster. The first viewport must answer: Is anything urgent? Which project or provider is affected? What can I do now?
- Allocation (`/allocation`): the existing policy controls and dedicated browser requests, grouped by capacity, subscriptions, and project shares. The save state stays visible while editing.
- Analytics (`/analytics`): full quota windows and trends, usage coverage and totals, machine and browser processes, live workspaces, advice, and activity history. Provide in-page wayfinding for these deeper sections.
- Project detail (`/p/<slug>`): preserve each published task board and live agents, with a route back to Overview.

## Interaction

A handover alert offers Plan, Prepare, inspect successor output, and Confirm activation in that order. Preparing creates a successor but leaves the source pane in control. The UI must show migration failure and a fresh bootstrap choice. Activation requires an explicit confirmation after the user can read the successor's output.

## Visual continuity

Preserve the incumbent light and dark palettes, restrained orange action accent, typography, and compact operational tone. Use clearer hierarchy, tables, and whitespace to reduce repeated cards and long alert prose. Do not invent status or consumption evidence.
