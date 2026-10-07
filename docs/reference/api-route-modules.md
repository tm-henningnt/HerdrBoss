# API route modules

Put one API route family in each named module under `src/api/`.

Export a handler that takes `(req, res, ctx)` and returns `true` after it sends a response. Return `false` when the handler does not match the request.

Call each handler after the shared request checks and before the remaining route branches in `serve()`.

Keep each URL, status code, header, response body, event stream, and fallback rule unchanged when you move a route.

Families moved:

- Model catalog: `GET /api/models` in `src/api/models.js`.
