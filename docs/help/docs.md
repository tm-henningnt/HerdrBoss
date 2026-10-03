# Docs help

The Docs page shows the Herdr Boss documentation. The service reads the text from Markdown files in the repository and renders it when you open a page. The page needs no build step.

## Find a page

Use the list of pages at the left. The list follows `docs/nav.json`. On a phone, select **Pages** to open the list. Select a page name to open it.

## Read a page

A link between two pages opens the other page. A link to a heading moves to that heading. On a wide screen, the list **On this page** shows the headings of the page. The links **Previous** and **Next** at the end of a page follow the order of the list. The line **Source** names the file of the page.

## Change a page

Edit the Markdown file that the line **Source** names. Do not edit a generated file: the service generates no file. The page shows the change after at most 30 seconds. Reload the page to see it at once.

A picture comes from `docs/images/`. Write its path in the Markdown, relative to the file. A picture from outside `docs/` does not show.

## Explainer

The page **How the parts work together** is a walkthrough of the parts of Herdr Boss. Each step highlights some boxes of a diagram and gives a short text. Select **Back** or **Next**, or select a step number. After you select the explainer, the left and right arrow keys, **Home**, and **End** also change the step. The walkthrough does not animate when your system asks for reduced motion.

## Page help

The Help panel of a dashboard page can show text from `docs/help/`. The Docs page lists the same files under **Page help**. A change in the file changes both places.

## Docs gate

A change of behavior needs a change of the docs or of the page help in the same branch. The check `node scripts/docs-gate.js` enforces this rule. See `docs/reference/docs-gate.md`.

## Access

The Docs page follows the access rule of the dashboard. A request from this computer needs no login. A request from another computer needs the access token. The service serves `README.md` and the files in `docs/` only.
