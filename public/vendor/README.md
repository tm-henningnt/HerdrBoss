# Vendored files

This folder holds the third-party files that the dashboard serves. Do not edit a file in this folder by hand. See [ADR 0026](../../docs/adr/0026-vendored-mermaid.md) for the reason.

## mermaid.min.js

| Item | Value |
|---|---|
| Package | `mermaid` |
| Version | `12.1.0` |
| File in the package | `dist/mermaid.min.js` |
| License | MIT. See `mermaid.LICENSE`. |
| SHA-256 | `6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2` |

The Docs section draws each Mermaid diagram with this file. The dashboard loads the file only on a page that has a diagram. The dashboard never loads Mermaid from a CDN.

## Update the file

1. Fetch the new package in a temporary folder outside the repository: `npm pack mermaid@<version>`.
2. Copy `dist/mermaid.min.js` and `LICENSE` from the package into this folder. Keep the file as it is.
3. Run `shasum -a 256 mermaid.min.js`. Write the new version and the new hash here and in the ADR.
4. Run `node --test test/vendor-mermaid.test.js`. The test checks the hash of the file against the value here.
