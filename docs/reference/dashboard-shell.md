# Dashboard shell and route registry

The dashboard shell is the part of the page that does not change between pages. It holds the shared menu, the Help panel, and the address rules.

## Add a route

The route registry is the one place that names the pages. It is `public/routes.js`. Add a record to `ROUTES` there. Then add the render branch in `public/app.js`.

Each record has these fields:

| Field | Meaning |
|---|---|
| `id` | The route name. The menu, the Help panel, and the render code use it. |
| `path` | The canonical address. |
| `label` | The menu label. |
| `menu` | The place in the main menu. Omit it for a page without a menu entry. |
| `help` | `inline` for a topic in `HELP` in `public/app.js`. `file` for `docs/help/<id>.md`. |
| `phone` | `true` when the page fills the phone viewport and hides the page header. |
| `keyed` | `true` when a render patches the page in place. |

## Modules

- `public/routes.js` holds the registry and the pure address rules. It has no DOM use.
- `public/shell.js` fills the shared menu, marks the current page, and applies the address rules to the location.
- `public/app-view.js` re-exports `APP_VIEW_ROUTES` from the registry.

The main menu has one host, the `nav` element `#primary-nav` in `public/index.html`. It holds Help, context links, and the Roamgate link. `mountMenu` in `public/shell.js` inserts the page links before them, in the `menu` order. A phone Mailbox page adds its folder links to this host. Phone app views use a button in the app bar to open this same menu.

## Client data store

Use `public/store.js` as the one place for shared API reads. It owns the cache, event stream, and refresh timers. `PAGE_READS` names the shared reads for each route. The store keeps one event stream for state, message, and review changes. It keeps the last successful value when an optional read fails. It reuses a request that is already running. It starts one refresh timer for each resource on the active route. Use `readUrl` for a page read with a changing URL. Keep a page read in the page when it has a separate life cycle, such as the live Browser preview.

## Shared rows, chips, and tokens

Use `public/components.js` for shared list rows and status chips. Use `public/theme.css` as the one place for color, spacing, type, border, and focus tokens.

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

`test/routes.test.js` covers the 14 routes, the three aliases, the task query, the fragments, and the shared menu host.
