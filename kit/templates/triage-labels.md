# Triage labels

The triage skills use five roles. This file maps each role to the label string in the issue tracker of this repository.

| Role | Label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | This will not be worked on. |

When a skill names a role, use the label string of that role from the table.

If the tracker uses other words, change the Label column.

## Create the labels

Run `herdr-boss gh label sync --preset triage` in the project root. The command creates a missing label and edits a label whose color or description differs. It never deletes a label.

Add `--dry-run` to print the plan without a change. The preset data is in `kit/label-presets.json` in the Herdr Boss repository.

`herdr-boss project new` runs the same sync for a new private GitHub repository.
