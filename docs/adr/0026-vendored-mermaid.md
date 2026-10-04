# ADR 0026: The dashboard vendors Mermaid to draw the Docs diagrams

Status: Accepted. Task DS2, from the Owner decision of 2026-10-04.

## Context

The Docs section renders Markdown from `README.md` and `docs/`. Nine Mermaid blocks exist in the documentation: eight in `docs/concepts.md` and one in `README.md`. [ADR 0025](0025-docs-section-from-markdown.md) recorded that the dashboard has no diagram library, so a Mermaid block showed as its source in a closed fold. The Owner decided that the dashboard must draw the diagrams.

The repository has no dependencies to install and no build step. GitHub draws the Mermaid blocks in the Markdown files. The dashboard must draw the same blocks, also without a network connection.

## Decision

1. **Vendor one file.** The dashboard serves the browser build `dist/mermaid.min.js` of the npm package `mermaid` from `public/vendor/`. The pinned version is 12.1.0. The SHA-256 of the file is `6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2`. The license text is `public/vendor/mermaid.LICENSE`. `public/vendor/README.md` records the version and the hash. A test reads the hash from that file and checks the vendored file, so the two cannot drift.
2. **One exception to the no-dependency rule.** Mermaid is the only third-party code in the dashboard. A diagram library is a large program with a parser and a layout engine. The repository does not write its own. No other dependency enters the repository. `package.json` stays without a runtime dependency.
3. **No CDN.** The dashboard loads `/vendor/mermaid.min.js` from its own service. It never loads Mermaid from a content delivery network. A factory dashboard works without an internet connection.
4. **Lazy load.** Only some Docs pages have a diagram. `public/docs-diagrams.js` loads the vendored file with a script element only when the page has at least one `[data-mermaid]` block. A page without a diagram downloads no Mermaid code.
5. **Render and fallback.** `src/docs-site.js` marks each Mermaid block. The script draws each block in place of the source fold and hides the fold. When the library does not load or a diagram does not parse, the script keeps the source fold and shows the line "The diagram could not be drawn.". The script sets `securityLevel: 'strict'`. The Markdown files stay unchanged, so GitHub still draws them.
6. **Theme and width.** The script draws the diagram in the light or the dark theme of the dashboard and draws it again when the theme changes. A diagram that is wider than a phone screen scrolls sideways in its own box.
7. **Update.** An update replaces `public/vendor/mermaid.min.js`, its license text, and the version and the hash in `public/vendor/README.md` and in this ADR, in one commit. The test then checks the new hash.

## Consequences

- The repository holds one large third-party file of about 5.5 MB.
- The Docs page loads the file at most once. A page without a diagram loads no part of it.
- The diagrams follow the light and the dark theme of the dashboard.
- A Mermaid block that fails to parse shows its source and one plain error line. The page stays usable.
- The consequence line of ADR 0025 about the diagram fold points to this ADR.

## Alternatives rejected

- **A CDN.** It needs an internet connection, and it gives a third party control of the code that the dashboard runs.
- **A build step that draws the diagrams to SVG files.** It creates generated files and needs a check that they are current. The Markdown files must stay the source for GitHub.
- **A second dependency in `package.json`.** It needs `npm install` and a build. The repository installs no dependency.
- **The ESM build with its chunks.** It is many files, not one. The task needs one vendored file.
