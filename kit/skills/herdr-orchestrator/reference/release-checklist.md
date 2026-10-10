# Release checklist

## Qlik extension release

Every release of a Qlik extension product ships the atlas / demo app as a separate `.qvf` asset with all sheets public; never inside the extension zips.

1. Use the project's configured `qlik-cli` session. Keep tenant hosts out of the repository and command output.
2. Run `node kit/skills/herdr-orchestrator/reference/qlik-demo-app.mjs APPID NAME [--qlik EXECUTABLE] [--NoData]`. Give it the app ID and a simple output name.
3. The helper lists objects with `qlik app object ls --app APPID --json`. It publishes each sheet that is private with `qlik app object publish OBJECTID --app APPID`.
4. The helper lists the objects again. It checks that the sheet count is unchanged and that every sheet is both published and approved.
5. The helper exports the app with `qlik app export APPID --output-file out/NAME.qvf`. Add `--NoData` only when the app has no synthetic data.
6. The helper scans the exported file. It prints counts only. It never prints app IDs, object IDs, matched content, or paths.
7. Run `herdr-boss release request` for the draft. Check that the approval card lists the separate demo app by name, size, and SHA-256.
8. Check that no extension ZIP contains a `.qvf` file. The release request refuses a Qlik extension draft that breaks this rule.
The pre-gate rule accepts an approval only when the recorded list has one separate `.qvf` and its `.qvf.sha256` companion, the fresh asset hashes, scan, and archive checks pass, and no extension archive contains a `.qvf`; only the Boss can cancel a failed approved request with `herdr-boss release cancel REPO TAG --force --reason TEXT`.

The helper takes the `qlik-cli` executable as an input and defaults to `qlik`. Tests inject a fake runner. They use no tenant connection.

The adapter reads object types from `type`, `objectType`, `qType`, `qInfo.qType`, `qMeta.type`, or `qMetaDef.type`.
It reads object IDs from `id`, `objectId`, `qId`, `qInfo.qId`, or `qMetaDef.qId`.
It reads state from the listing when the listing has state fields.
Published fields may use `published`, `isPublished`, `meta.published`, `qMeta.published`, or `qMetaDef.published`.
Approved fields may use `approved`, `isApproved`, `meta.approved`, `qMeta.approved`, or `qMetaDef.approved`.
If the listing has no state, the helper runs `qlik app object properties ID --app APPID --json` for each sheet.
It reads `qMeta.published` and `qMeta.approved` from that output.
The helper refuses if either state value is missing.
The helper prints a fixed message for each known refusal. It does not print input values.
App and sheet IDs must start with a letter or number and may contain only letters, numbers, `_`, or `-`.
The helper refuses when a listing has more than 500 sheets or duplicate sheet IDs.
No `qlik-cli` version is pinned.
Add a fixture when the installed output uses another field.

The helper scan reports counts for private key blocks, token-like strings, private paths, URL hosts, allowed Qlik Engine inline paths, and bytes. It stops when it finds a private key block, token-like string, private path, or a file that exceeds the scan limit. `release request` runs the full release scan, including the browser-session host check.
