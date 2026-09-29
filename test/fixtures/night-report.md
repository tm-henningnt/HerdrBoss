# Night report – 2026-09-29

## Summary

**Done:** 7 tasks merged and live. **Blocked:** 1 task waits for the Owner.

The suite ran in `herdr-boss suite -- npm test` once per integrated tree.

## Projects

1. **Atlas**
   - Merged `a3timeline` and `a4export`.
   - The export now writes `~/Projects/Atlas/out/report.csv`.
2. **Harbor**
   - The deploy check failed once – the retry passed.
   - Waits for a decision:
     - [x] Keep the old queue name.
     - [ ] Rename the queue to `harbor-jobs`.
3. **Ledger**
   - No change.

## Worker results

| Worker | Project | Tasks | Tokens | Result |
| :--- | :--- | ---: | ---: | :---: |
| a3timeline | Atlas | 2 | 184,220 | done |
| h7deploy | Harbor | 1 | 96,004 | retry |
| g1lockhash | HerdrBoss | 3 | 211,870 | done |

## Lock waits

| Lock | Holds | Median hold (s) | Median wait (s) |
| --- | ---: | ---: | ---: |
| full-suite | 5 | 412 | 38 |
| browser | 2 | 61 | 0 |

> **Note:** The Harbor retry used a new worker.
> See the [lock ledger docs](https://example.com/herdr/locks) for the medians.

---

```sh
herdr-boss lanes --json
```

_Next:_ run the Atlas export check at 07:00.
