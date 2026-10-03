# Explainer page

The page `explainer` of the Docs section is a stepped walkthrough of the parts of Herdr Boss. The file `docs/explainer.md` gives its title and introduction. The module `public/explainer.js` draws the walkthrough below that text. The style sheet is `public/explainer.css`.

## Change the text of a step

The steps are the array `STEPS` at the top of `public/explainer.js`. Edit the text there. No build step exists.

Each step has these fields:

| Field | Content |
|---|---|
| `id` | A short name of the step. Each `id` is unique. |
| `title` | The title of the step. |
| `parts` | The ids of the boxes to highlight. Each id is in `PART_IDS`. |
| `text` | The sentences of the step. Use 2 to 4 short sentences. |

Write each sentence in Simplified Technical English. Each claim must match a file in `docs/` or the code. Write no host name, address, or private path.

## Change the boxes

The array `PARTS` lists the boxes. The field `group` puts a box in a row of the diagram: `top`, `control`, `panes`, or `shared`. The frames `panes` and `factory` have no entry in `PARTS`. A new box needs a style check at the widths 1280 and 360.

## How the page loads

The Docs view adds the element `<div class="explainer" data-explainer>` to the page named `explainer`. The dashboard loads `public/explainer.js` only when that element shows. The module keeps the current step, so a new render of the dashboard starts the walkthrough again at the same step.

## Use

| Action | Result |
|---|---|
| **Next**, **Back** | Go to the next or the previous step. |
| A step number | Go to that step. |
| Left or right arrow | Go to the previous or the next step. |
| **Home**, **End** | Go to the first or the last step. |

The arrow keys work while the focus is in the explainer. The text of the step is an `aria-live` region, so a screen reader reads each new step. The explainer uses the colour tokens of the dashboard, so it follows the light and the dark theme. It does not animate when the system asks for reduced motion.
