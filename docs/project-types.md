# Project types

A project type is one folder with one `manifest.json` file. The manifest declares the files and rules for a project type. Herdr Boss reads the same manifest contract for every type.

Use `kit/project-types/manifest.schema.json` as the schema. Set `schema` to `herdr-boss.project-type/1`. The validator rejects an unknown field, an unsupported setup operation, an unsafe path, or a named file that is missing.

## Type folder

Keep `manifest.json` in the type folder. Keep every file named by the manifest in that folder. Use paths relative to the folder. Use `/` between path parts. Do not use an absolute path, a `.` or `..` part, or a backslash. A symlink must resolve to a file inside the type folder.

The manifest uses these fields:

| Field | Meaning |
| --- | --- |
| `schema` | The manifest contract version. |
| `id` | A stable lower-case type ID. |
| `title` | The name shown to the Owner. |
| `version` | The type revision saved with a project. |
| `default` | Whether this type is the default. A catalog has exactly one default. |
| `templateRepository` | A template repository URL and pinned revision, or `null`. |
| `setupSteps` | Ordered operations handled by the shared starter. |
| `templates` | Template files to copy into a project. |
| `agentsSections` | Files and headings for type-specific `AGENTS.md` sections. |
| `gates` | Required command checks and their expected output. |
| `trackerPreset` | Suggested triage labels and labels for each tracker state. |
| `releaseFlow` | A release repository, approval step, scan rules, assets, and checklist, or `null`. |
| `settings` | Settings with a name, type, default, and project edit rule. |
| `checks` | Files, scripts, setting names, and versions that project checks inspect. |
| `requiredInputs` | Inputs with a kind, required flag, and project destination path. |
| `licenseMode` | The string values that projects of this type may select, and the default. |

`setupSteps` accepts `copy-template`, `write-agent-sections`, and `apply-settings`. A step cannot run a command or call a type-specific hook. Gate commands describe checks. The starter does not run them during project creation.

The validator checks that IDs inside each manifest are unique. It checks that type IDs in a catalog are unique. It checks that one type is the default. It checks each template, agent section, check script or file, release asset, and release checklist named by the manifest.

## License mode

Each type declares its own `licenseMode.values` list and `licenseMode.default`. Keep these values as strings. Do not use a fixed list of license modes in Herdr Boss code. A project's `licenseMode` field holds one value from its selected type. The project can use the type default when it has no override.

One type may choose a value for a warning, another may choose a value for strict enforcement, and another may choose a value for no license check. Each type owns its strings. The generic type declares `none` as its only value.

Do not put a license, token, licensed state, tenant host, client name, or private project input in a type folder. Keep private input in the project's private input area.

## Generic type

The `generic` type is the minimal default. It has no template files, type-specific agent sections, release flow, extra settings, or checks. It accepts optional PRD and mock image inputs. It declares the common repository and documentation gates. The starter still uses the shared project setup flow and tracker choice.

Add a type by adding a folder with a valid manifest and each declared file. A new valid type does not require a source change.

## Check a type

Check one type folder:

```sh
herdr-boss project type check kit/project-types/generic
```

Check a catalog folder that contains type folders:

```sh
herdr-boss project type check kit/project-types
```

Both commands read the folder and write nothing. The catalog check also rejects duplicate type IDs and multiple defaults.
