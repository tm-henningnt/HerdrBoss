# ADR 0025: The Docs section renders Markdown at request time with a small module

Status: Accepted. Task DS1a, from the Owner request of 2026-10-03.

## Context

The Owner wants one editable source for the documentation, and a Docs section in the dashboard built from it. Nobody edits generated output. The repository has no dependencies to install. The Owner likes 11ty and has no preference.

The dashboard already has a Markdown renderer, `public/markdown.js`. It has no dependency, builds HTML only from its own tokens, and the tests import it in Node.

The Help panel of the dashboard held long help text as HTML strings in `public/app.js`. The same facts were in `docs/user-guide.md`.

## Decision

1. **Script, not 11ty.** `src/docs-site.js` reads `README.md` and `docs/**/*.md`, renders each page with `public/markdown.js`, and serves it. It needs no dependency and no build step. 11ty needs `npm install`, a build output folder, and a second template system. The pages need none of its features: no collections, no data cascade, no plugins. The tree needs one list, `docs/nav.json`. A script does the whole task, so 11ty is not used.
2. **Render in memory.** The service renders a page when a request arrives. It keeps the result in a cache that is keyed on the file name and the modified time of the file. It scans the file list at most once in 2 seconds. The cache restarts when the set of files changes. No generated file exists in the repository or on disk.
3. **Renderer extension.** `renderMarkdown` takes optional settings for the Docs section: URL hooks for links and images, heading ids, the lowest heading level, and a larger input limit. Without these settings the output is the same as before, so the Mailbox and the Chat do not change. A link hook cannot write an unsafe URL: the result still passes `safeUrl`.
4. **Page names.** `README.md` is the front page, `docs/<path>.md` is the page `<path>`, and `docs/<dir>/index.md` is the page `<dir>`. A page opens at `/docs/<name>` inside the dashboard. A link between pages in the Markdown uses the file path, for example `../cli.md#section`. The service rewrites it to the page address. A link to a file that is not a page shows as text.
5. **Tree.** `docs/nav.json` lists sections of page names. A name that ends in `/*` adds each page of that folder. A page that the list omits still opens, and the tree does not show it. The title of a page is its first heading.
6. **Access.** The routes sit behind the access check of the dashboard: a request from this computer needs no login, and a request from another computer needs the access token. The service reads only `README.md` and the Markdown files and image files under `docs/`. A name that leaves `docs/` is refused, and so is a link to a file outside `docs/`. `README.md` and `docs/nav.json` are read only when their real path is inside the repository. Image files must resolve, after links are followed, to a path inside `docs/`. Tests cover the traversal cases at the module and at the HTTP boundary.
7. **Page help from the same files.** The text of a Help panel topic is a file `docs/help/<topic>.md`. The first heading is the title. The sections start at `##`. The Help panel reads `/api/docs/help/<topic>`, and the Docs section lists the same file under "Page help". `public/app.js` holds no copy of a topic that has a file. The list `HELP_FILES` in `public/app.js` names the topics that have a file, and a test checks that each one has a file and no second copy.

## Topics that moved and topics that stay

Moved: Board, Browsers, Fleet, and Docs.

Stay in `public/app.js` for now: Overview, Projects, Mailbox, Reviews, Chat, Allocation, Agents, Analytics, and Settings. Test files assert on the HTML of some of these topics, and a move needs those assertions to read the Markdown file. The Settings topic includes the generated settings guide.

Rule for the remaining topics: when a topic changes, move it to `docs/help/<topic>.md` in the same change, and add the topic name to `HELP_FILES`. Move a topic only together with its test assertions.

Settings text has its own single source already. `public/setting-help.js` builds the settings popups, the settings guide in the Help panel, and a generated block in `docs/cli.md`. A test fails when the block is out of date. This rule stays.

## Consequences

- A change to a help file changes the Help panel and the Docs section at once.
- A Mermaid diagram shows as its source in a closed fold when the diagram does not draw. [ADR 0026](0026-vendored-mermaid.md) adds a vendored Mermaid build that draws it.
- Raw HTML in a Markdown file shows as text, except comments, which the service removes, and a `<picture>` block with a dark source. A `<picture>` block becomes a light and a dark image, and the style sheet shows the one that matches the theme.
- The dashboard reads a page again at most every 30 seconds. A reload shows a change at once.
- The scan of the file list is synchronous. It runs at most once in 2 seconds and reads only file metadata, so a request waits at most for that scan.
- The page cache holds at most 200 pages. The signature of the index includes the image files, so a new image refreshes the pages. An image can be at most 8 MB.
- A page can be at most 2 MB. The index holds at most 2000 files and 6 folder levels.

## Alternatives rejected

- **11ty.** See decision 1.
- **A build script that writes HTML into the repository.** It creates generated output that people could edit, and it needs a check that the output is current.
- **Help text in JSON.** It adds a third format. Markdown is the format of the docs.
