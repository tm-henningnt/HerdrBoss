# Engine tick phases

`Engine.tick()` names three kinds of work:

- `collect` reads source data.
- `derive` selects fresh readings or fallbacks and builds state.
- `act` applies policy and runs enabled actions.

The pure `deriveTickReadings()` function in `src/engine-tick.js` selects the Herdr, machine, and process readings. It keeps the last good Herdr snapshot when a new read fails. `Engine` accepts its clock and collectors as constructor options.
