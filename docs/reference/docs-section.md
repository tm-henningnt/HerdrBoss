# Docs section

The Docs section of the dashboard shows `README.md` and the Markdown files in `docs/` as pages. The service renders them when you open a page. It writes no file. See `docs/adr/0025-docs-section-from-markdown.md` for the reasons.

## Pages

A page name comes from the path of its file.

| File | Page name | Address |
|---|---|---|
| `README.md` | (empty) | `/docs` |
| `docs/start-here.md` | `start-here` | `/docs/start-here` |
| `docs/guide/see.md` | `guide/see` | `/docs/guide/see` |
| `docs/reference/index.md` | `reference` | `/docs/reference` |

The service ignores folders and files that start with a dot, and it ignores symbolic links.

The title of a page is its first heading. Each heading has an anchor. The anchor is the GitHub form of the heading text with the prefix `d-`. The heading `Find a page` has the anchor `#d-find-a-page`.

## Links and images

Write a link to another page as a relative file path, for example `[CLI](../cli.md#section)`. The service changes it to the address of the page. A link to a file that is not a page shows as text.

Write an image as a relative path to a file under `docs/`, for example `![Overview](images/readme/overview.png)`. An image from outside `docs/` shows as its alt text. Allowed image types: `png`, `jpg`, `jpeg`, `webp`, `gif`, and `svg`.

A `<picture>` block with a `prefers-color-scheme: dark` source shows the light image in the light theme and the dark image in the dark theme. HTML comments do not show. Other raw HTML shows as text.

A Mermaid code block shows as its source in a closed fold.

## The page list

`docs/nav.json` gives the tree:

```json
{
  "sections": [
    { "title": "Start", "pages": ["", "start-here"] },
    { "title": "Reference", "pages": ["reference/*", "cli"] }
  ]
}
```

A name that ends in `/*` adds each page of that folder, with the folder page first. A page that the list does not name still opens at its address. The tree does not show it.

## Page help

A file `docs/help/<topic>.md` is the text of the Help panel for one dashboard page. The first heading is the title of the panel. Start the sections with `##`. The topics that have a file are named in `HELP_FILES` in `public/app.js`. The Docs section lists the files under "Page help".

## Routes

All routes use GET. They need the same access as the dashboard.

| Route | Answer |
|---|---|
| `/docs`, `/docs/<name>` | The dashboard shell. The page loads its content from the routes below. |
| `/api/docs/tree` | `{ sections: [{ title, pages: [{ name, title }] }], count }` |
| `/api/docs/page?path=<name>` | `{ name, title, source, html, headings }`. The `path` of the front page is empty. |
| `/api/docs/help/<topic>` | `{ topic, title, html }` for a file in `docs/help/`. |
| `/docs/<path>.<image type>` | The image file under `docs/`. |

A name that is not a plain page name gets status 400. An unknown page, topic, or image gets status 404. A name that leaves `docs/` never returns a file.

## Limits

| Limit | Value |
|---|---|
| Page size | 2 MB |
| Image size | 8 MB (status 413 above it) |
| Pages in the cache | 200 |
| Files in the index | 2000 |
| Folder levels | 6 |
| Scan interval | 2 seconds |
| Page refresh in the dashboard | 30 seconds |
