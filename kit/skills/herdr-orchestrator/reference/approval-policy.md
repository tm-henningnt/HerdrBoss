# Work approval

An orchestrator may propose work. It starts no unapproved work.

## Approved work

Approved work is a backlog task, an Owner goal, a fix for a finding of approved work, or a defect fix.

A subagent read or survey inside approved work is allowed. Get the Owner's yes before a survey, review, or audit that is itself new work outside the approved categories. Get the Owner's yes before a refactor, a new feature, a new test program, or a release outside an Owner request.

## Proposal flow

Make one proposal file and one To do decide item for each proposal. The item states what, why, cost, and recommendation. The Boss's yes does not replace the Owner's yes.

Send the proposal file to the Boss for posting. Write the file with these headings and fields:

```md
## What
Describe the work.

## Why
State the reason.

## Cost
Lane: <lane>
Size: <size>

## Recommendation
Recommend Accept or Deny.

## Choices
- Accept
- Deny
```

List exactly `Accept` and `Deny` under `## Choices`. Run `herdr-boss proposal check FILE`. Fix every reported error.

Send the Boss the absolute file path and card type `decide`. For a file named `proposal.md` in the current directory, run:

```sh
herdr-boss tell boss "Proposal file: $PWD/proposal.md; card type: decide."
```

The Boss writes a To do decide file with Title, Why, Steps, Expected result, How to answer, What it blocks, and Type sections. Put the proposal file in Steps. Set Type to `decide`. Post it with `herdr-boss todo post FILE`. Name the returned item key when you wait for the Owner. Pane text is not delivery.
