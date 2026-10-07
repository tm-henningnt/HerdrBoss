# Dashboard shell and route registry

The dashboard shell is the part of the page that does not change between pages. It holds the menu, the Help panel, the phone drawer, and the address rules.

## Add a route

The route registry is the one place that names the pages. It is `public/routes.js`. Add a record to `ROUTES` there. Then add the render branch in `public/app.js`.

Each record has these fields:

| Field | Meaning |
|---|---|
| `id` | The route name. The menu, the Help panel, and the render code use it. |
| `path` | The canonical address. |
| `label` | The menu label and the menu button text. |
| `menu` | The place in the main menu. Omit it for a page without a menu entry. |
| `drawer` | `true` for a link in the phone drawer of the Mailbox, the Reviews, and the Chat. |
| `help` | `inline` for a topic in `HELP` in `public/app.js`. `file` for `docs/help/<id>.md`. |
| `phone` | `true` when the page fills the phone viewport and hides the page header. |
| `keyed` | `true` when a render patches the page in place. |

## Modules

- `public/routes.js` holds the registry and the pure address rules. It has no DOM use.
- `public/shell.js` fills the menu, marks the current page, builds the drawer links, and applies the address rules to the location.
- `public/app-view.js` re-exports `APP_VIEW_ROUTES` from the registry.

The main menu has one host, the `nav` element `#primary-nav` in `public/index.html`. `index.html` holds only the Roamgate link. `mountMenu` in `public/shell.js` inserts the page links before it, in the `menu` order.

## Address rules

`matchRoute(pathname)` gives the route of an address. An address that no route names opens the Overview. `/projects/<slug>` gives the route `projects` and the slug. `/docs/...` gives `docs`. `/reviews/...` gives `reviews`. `/fleet/add-host` gives `add-host`.

`helpRoute(pathname)` gives the Help topic. It reads `/p/<slug>` as `projects`.

`resolveAlias(pathname, hash)` replaces three old addresses:

| Old address | New address |
|---|---|
| `/p/<slug>` | `/projects/<slug>` |
| `/organization` | `/agents?view=chart` |
| `/logs` | `/analytics#activity`, or `/#overview-guidance` when the fragment is `#guidance` |

`taskFromQuery(pathname, search)` reads `?task=<id>` on a project page address. A Board card links to such an address. The page selects the task once and removes the query from the address.

## Tests

`test/routes.test.js` covers the 14 routes, the three aliases, the task query, the fragments, the menu host, and the phone drawer.
