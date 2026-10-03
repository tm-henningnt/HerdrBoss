# Docs help

The Docs page shows the Herdr Boss documentation. The service reads the text from Markdown files in the repository and renders it when you open a page. The page needs no build step.

## Find a page

Use the list of pages at the left. The list follows `docs/nav.json`. On a phone, select **Pages** to open the list. Select a page name to open it.

## Read a page

A link between two pages opens the other page. A link to a heading moves to that heading. On a wide screen, the list **On this page** shows the headings of the page. The links **Previous** and **Next** at the end of a page follow the order of the list. The line **Source** names the file of the page.

## Change a page

Edit the Markdown file that the line **Source** names. Do not edit a generated file: the service generates no file. The page shows the change after at most 30 seconds. Reload the page to see it at once.

A picture comes from `docs/images/`. Write its path in the Markdown, relative to the file. A picture from outside `docs/` does not show.

## Page help

The Help panel of a dashboard page can show text from `docs/help/`. The Docs page lists the same files under **Page help**. A change in the file changes both places.

## Access

The Docs page follows the access rule of the dashboard. A request from this computer needs no login. A request from another computer needs the access token. The service serves `README.md` and the files in `docs/` only.
