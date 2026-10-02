# Quota reset planner

## Scope

The planner calculates quota guidance for one provider window.
Codex is the first caller.
The model also supports other providers.
The core reads no file.
The core reads no clock.
The caller supplies time and data.
This task adds the design, the core, and unit tests.

## Model

A window contains 100 percentage points of quota.
Usage is the used part of this window.
Consumption is the sum of new usage across all windows.
A regular reset sets usage to zero.
It moves the next regular reset by one window.
A credit sets usage to zero.
It sets the next regular reset to its application time plus one window.
An announced full reset has the same effect.
A partial reset subtracts a refund from usage.
It does not move the next regular reset.
Unused capacity does not carry into a new window.

The planned curve has a burst phase before each credit.
Each burst uses `burstPace` until usage reaches the application threshold.
The default threshold is 95 percent.
Usage stays at the threshold if the plan holds a credit.
After the final planned credit, the curve uses the natural pace.
This pace uses the remaining quota evenly before the next regular reset.
Each later regular window uses 100 points evenly over the window.
The core counts time on a threshold plateau as idle time.
An unannounced reset can invalidate a plan.
Recalculate the plan when a reading or an event changes.

## Exact event calculation

`calculateExhaustionPlan(input)` calculates full-exhaustion events without a search.
It supplies the exact comparison with the reference simulator.
It keeps the constant rate after the last credit.
`planQuota(input)` supplies the paced plan for later guidance.
It uses the threshold for its burst events.
It uses the natural pace after the last planned credit.
Both functions use exact time differences between events.
Use a constant burn rate `b`, in percentage points per hour.
Let `W` be the window length in hours.
The default window length is 168 hours.
Let `u` be current usage.
Let `E` be the horizon.
For two credits, calculate:

```text
L  = 100 / b
T1 = now + (100 - u) / b
T2 = T1 + L
R1 = T2 + W
R2 = T2 + 2W
```

These equations require exhaustion before the current regular reset.
Each credit must remain available at its calculated time.
There must be no intervening announced reset or hold time.
After the final credit, each regular window starts at `T2 + kW`.
For `L <= W`, consumption in each complete regular window is 100 points.
Before the first credit, consumption is `min(100 - u, b(E - now))`.
After that credit, sum each window contribution:

```text
C = (100 - u) + sum(min(100, b * durationOfWindowBeforeE))
```

For `E >= T2`, the two-credit case is:

```text
D = E - T2
n = floor(D / W)
C = (100 - u) + 100 + 100*n + min(100, b*(D - n*W))
idleHours = (E - now) - C/b
```

Use hours for every time difference in these equations.
The sum counts a window that ends exactly at the horizon.
The exact function also processes an earlier regular reset as an event.
The simple `T1` equation does not apply in that case.
The exact function rejects an expiry before exhaustion.
Use the search planner for that case.

### Worked example

All dates and values in this document are invented.
Set `now` to 2032-04-01 00:00 UTC.
Set usage to 1 percent.
Set `b` to 1.5 percent per hour.
Set the current regular reset to 2032-04-08 00:00 UTC.
Credit A expires at hour 400.
Credit B expires at hour 600.
Set the horizon to hour 500.

| Event | Hours after now | Time in UTC |
| --- | ---: | --- |
| Apply A at exhaustion | 66 | 2032-04-03 18:00 |
| Apply B at exhaustion | 132.6666667 | 2032-04-06 12:40 |
| First regular reset after B | 300.6666667 | 2032-04-13 12:40 |
| Second regular reset after B | 468.6666667 | 2032-04-20 12:40 |
| Horizon | 500 | 2032-04-21 20:00 |

`L` is 66 hours and 40 minutes.
The first interval consumes 99 points.
The interval between credits consumes 100 points.
The next two complete windows consume 200 points.
The last partial window consumes 47 points.
Total consumption is 446 points.
Idle time is 202 hours and 40 minutes.
Without credits, consumption is 299 points.
The gain is 147 points against constant demand without credits.
These totals describe the full-exhaustion comparison.
Use the paced totals below for the fleet plan.

## Inputs and outputs

The core uses the reading names `usedPercent` and `resetsAt`.
`src/usage.js` writes history rows with `at`, `provider`, and `window`.
It also writes `usedPercent`, `resetsAt`, and pacing fields.
The core does not import that file.
The caller must select the provider and the quota window.

Use these fields with `planQuota(input)`:

| Field | Meaning | Default |
| --- | --- | --- |
| `now` | Current time as UTC ISO text or epoch milliseconds | Required |
| `usedPercent` | Current usage from 0 to 100 | Required |
| `resetsAt` | Current regular reset time | Required |
| `windowHours` | Window length in hours | 168 |
| `credits` | Available credit records | Empty array |
| `horizon` | End of the calculation | Last available expiry; one window after `now` if there is no credit |
| `burstPace` | Burst rate in points per hour | 1.0 |
| `maxBurnRate` | Earlier input name for the burst rate | Used only when `burstPace` is absent |
| `slowBurnRate` | Burst rate for the slow scenario | Half the burst rate |
| `applyThreshold` | Highest permitted application threshold | `100 - margin` |
| `margin` | Capacity kept outside the burst phase, in points | 5 |
| `targetPace` | Optional limit on the natural pace, in points per hour | No extra limit |
| `announcedResets` | Known full or partial reset events | Empty array |
| `whatIf` | One extra hypothetical reset event | Absent |

The effective threshold is the lower of `applyThreshold` and `100 - margin`.
Set `margin` to zero to permit a threshold of 100.
A target pace can leave quota unused at the regular reset.
It cannot raise the natural pace above the even pace.
The caller can use the history helper to suggest a burst setting.
The core does not change that setting from history by itself.

Each credit has an `id` and an `expires_at` time.
The alias `expiresAt` is also accepted.
An absent ID becomes `credit-N` from its input position.
Assign this ID before any status or expiry filter.
Marking an earlier credit used must not rename a later credit.
IDs must be unique.
The core accepts an absent status, `available`, or `banked`.
It excludes other statuses and past expiries.
`granted_at` can remain on the source record.
The core does not use it.
An optional `notBefore` time holds a credit for a later period.
This time must not follow its expiry.
The core processes credits in expiry order.
Hold times keep that order.

Each reset has `at` and `kind`.
The kinds are `full` and `partial`.
The default kind is `full`.
A partial reset also has `refundPercent`, from 0 to 100.
The refund is a number of points.
It cannot make usage negative.
The core ignores events before `now` and after the horizon.
At the same time, process the regular reset first.
Then process announced resets in input order.
Then apply a credit.

The plan exposes the fast scenario at the top level.
It also returns `fast` and `slow` scenarios.
Each scenario has these fields:

| Field | Meaning |
| --- | --- |
| `method` | Selected `natural`, `exact`, or `search` candidate |
| `burnRate` | Burst rate for this scenario |
| `credits` | Credit IDs, expiries, application times, usage, reasons, and timing bounds |
| `curve` | Ordered points with `at`, `usedPercent`, `totalConsumed`, and `phase` |
| `windows` | Window start, end, reset time, start reason, and curve points |
| `resets` | Reset times, kinds, and resulting regular reset times |
| `totalConsumed` | Points consumed through the horizon |
| `gain` | Consumption minus the no-credit natural plan |
| `idleHours` | Time with no planned burn capacity or a zero pace |
| `baseline` | The natural plan with the same announced resets and no credits |

A credit has `earliestAt`, `bestAt`, and `latestAt`.
`bestAt` equals `applyAt` in the selected plan.
The other bounds assume the selected earlier credits.
They do not promise the same gain at every time in the range.
A regular reset can split this range into separate eligible intervals.
Re-plan if the Owner selects another time.
An unused credit has a null `applyAt` and a null `bestAt`.
A missing eligible time has a null bound.
An expiry application below the threshold has reason `expiry`.
The gain can be negative when expiry forces an application before useful exhaustion.
Do not hide that result.

### Curve lookup and guidance

Call `plannedUsageAt(plan, time)` to get planned usage in percent.
The function interpolates between adjacent curve points.
At a reset, it uses the point after the reset.
It uses the first value before the curve starts.
It uses the final value after the horizon.
Do not use that final value as a forecast beyond the horizon.

Call `usageGuidance(plan, time, usedPercent, tolerance)` for a comparison.
The default tolerance is 5 points.
Usage more than the tolerance below the curve gives `spend`.
Usage within the tolerance gives `normal`.
Usage more than the tolerance above the curve gives `hold`.
The threshold edges count as `normal`.
This result is guidance only.

### History helpers

Call `hourlyBurnP90(readings, { now, provider, window })`.
Select one provider and one window.
The helper rejects a mixed series without that selection.
It uses the last 14 days through the supplied `now`.
It divides a positive increase by the elapsed hours.
It distributes that rate across UTC hourly buckets.
This rule prevents frequent readings from adding extra percentile votes.
Include measured idle intervals as zero rates.
Exclude intervals with a usage drop or a changed regular reset time.
Exclude invalid readings and future readings.
Use the nearest-rank 90th percentile of the bucket rates.
Return zero when there is no valid interval.
A rate across a long gap is an average estimate.
It does not prove the peak rate within that gap.

Call `detectedReset(before, after)` with consecutive readings.
The readings must have the same provider and window.
The second reading must be later.
The helper returns true only for a drop greater than 30 points.
It does not identify which credit or provider event caused the drop.

## Algorithm

First calculate simple burst events without a search.
With threshold `q`, the first burst takes `max(0, q - u) / b` hours.
Each later burst takes `q / b` hours.
Each credit sets the next regular reset to its time plus `W`.
Use the exact full-exhaustion function separately when `q = 100` needs a reference result.

Compare the exact candidate with the search result.
Also compare with the no-credit natural plan when all credits are optional.
Keep the candidate with the highest consumption.
A credit is optional when its expiry follows the horizon.
Keep the expiry application rule for other credits.
Search also covers announced resets, hold times, and a target pace.
Construct an hourly grid from `now` through the horizon.
Include exact expiries and hold boundaries in the grid.
Include the exact threshold time for each prefix.
Include each regular and announced reset time.
Include one hour after each event.
For each credit, keep the highest-consumption prefix at each application time.
After application, usage is zero and the reset is one window later.
Thus the future state depends on that application time.
An inferior prefix at the same time cannot improve the final score.
This rule avoids a search over every complete schedule combination.
Skip intervals below the threshold when no expiry can occur within them.
For the final credit with no later announcement, the natural tail has a constant pace.
A later time on a threshold plateau cannot improve consumption in that case.
Search its event times and hold boundary directly.
When the natural pace is zero, also keep the instant before each reset.

Require the threshold at each candidate time.
Permit a lower usage only at the exact expiry.
Require application by the expiry when it falls within the horizon.
An expiry within 48 hours is not an immediate below-threshold application.
The later Owner prompt warns about that deadline.
Do not apply after expiry.
Permit an unused credit when its expiry follows the horizon.
Maximize consumption through the horizon under these rules.

Retain the four best complete candidate schedules.
Refine each schedule within one hour of its candidate times.
Use minute candidates and exact threshold event times.
Run two refinement passes.
Keep improvements in consumption.
For equal totals, prefer later application times in credit order.
Keeping an optional credit counts as applying later than any time in the horizon.
The grid search is optimal on its candidate grid.
The refinement is local.
It does not prove a global optimum over all continuous times.

## Synthetic history and paced examples

The test fixture has 337 hourly readings over 14 days.
Its invented dates end at 2032-04-01 00:00 UTC.
It resets once each week.
Each daily pattern has eight idle hours.
Then it has four hours at 1.5 points per hour.
The remaining twelve hours use 0.5 points per hour.
The last reading before each reset has 83.5 percent used.
The reset reading has zero used.
The history helper returns a p90 rate of 1.5.

Use a current synthetic reading of 1 percent for the examples.
Use the same regular reset and credit expiries as the exact example.
Call `burstTable(inputs)` to compare the default burst settings.
The function uses the last available expiry as its horizon.
It overrides a shorter input horizon for this comparison.
The last expiry in this example is 2032-04-26 00:00 UTC, at hour 600.
The no-credit natural plan consumes 356.142857 points by that time.

| Burst pace, points/hour | Consumed by last expiry | Gain | Apply A, UTC | Apply B, UTC |
| ---: | ---: | ---: | --- | --- |
| 0.8 | 405.517857 | 49.375000 | 2032-04-05 21:30 | 2032-04-10 20:15 |
| 1.0 | 433.642857 | 77.500000 | 2032-04-04 22:00 | 2032-04-08 21:00 |
| 1.2 | 452.392857 | 96.250000 | 2032-04-04 06:20 | 2032-04-07 13:30 |
| 1.5 | 471.142857 | 115.000000 | 2032-04-03 14:40 | 2032-04-06 06:00 |
| 2.0 | 489.892857 | 133.750000 | 2032-04-02 23:00 | 2032-04-04 22:30 |

`burstTable(inputs, paces)` accepts another list of settings.
Each row has `burstPace`, `totalConsumedByLastExpiry`, `gainAgainstNoCredits`, and `creditTimes`.
In this example, a faster burst never gives a later first credit time.
The curve at 1.5 reaches 95 percent after 62 hours and 40 minutes.
The second burst takes 63 hours and 20 minutes.
The final credit is at hour 126.
The curve then uses `100 / 168` points per hour.
The next regular resets are at hours 294 and 462.
At hour 500, the paced plan has consumed 411.619048 points.
The full-exhaustion comparison at that horizon consumes 446 points.
These are different demand policies.

## Range and safety

Show fast and slow scenarios together.
These names describe burst rates.
They do not describe sorted consumption bounds.
Use the configured burst pace for the fast scenario.
Use half that rate for the slow scenario by default.
At a burst pace of 1.5, the slow burst pace is 0.75.
Through hour 600, the fast plan consumes 471.142857 points.
The slow plan consumes 396.142857 points.
Their gains are 115 points and 40 points.
Both plans use the even natural pace after the final credit.
Neither scenario is a guarantee.
Do not infer a probability from these scenarios.
Do not assume that the faster setting makes every candidate plan consume more.
Do not add an unannounced gift reset to either scenario.
Use `whatIf` to examine a hypothetical reset.

### Reset-adjacent example

Use invented sample labels P and Q.
Set usage to 94 percent.
Set the regular reset to one hour after `now`.
Set one credit expiry and the horizon to hour 200.
Use a window of 168 hours.
Sample P uses a burst pace of 1 point per hour.
Its first eligible threshold is at hour 96, after the regular reset.
Sample Q uses a burst pace of 2 points per hour.
Its first eligible threshold is at hour 0.5, before the regular reset.

| Sample | Candidate | Apply hour | Total consumed |
| --- | --- | ---: | ---: |
| P | First eligible threshold | 96 | 157.904762 |
| Q | First eligible threshold | 0.5 | 119.750000 |
| Q | Selected search result | 48.5 | 186.178571 |

The faster first-threshold candidate consumes less in this corner case.
It moves the regular reset that was only one hour away.
The comparison now rejects that candidate.
It selects a later burst after the original regular reset.
The selected totals for this example are 186.178571 and 157.904762.
Show each scenario's curve and total separately.

Keep a margin before exhaustion.
The default application threshold is 95 percent used.
At an expiry, allow application below the threshold.
Never schedule application after an expiry.
Herdr Boss must never apply a credit itself.
The Owner applies a credit in the provider app.
The plan must never refuse a worker start by itself.
Keep the reserve rule in `src/rules.js`.

## Reference simulator

The first simulator advances in hourly steps.
It burns at a constant rate until capacity is exhausted.
It applies a credit at exhaustion or in the last hour before expiry.
It sets the next regular reset to 168 hours after application.
Its final hourly step can extend beyond the horizon.
Its application times round to the next hourly step.
It does not search for the best credit schedule.

The test file contains a copy with invented dates.
That copy clips the last step to the horizon.
The tests compare it with the exact event calculation.
Aligned event times must give equal results.
Fractional event times can give different results through hourly rounding.
The core calculates consumption between events without time rounding.
The search uses an hourly grid and then refines the selected times.
The paced plan caps each burst at the application threshold.
It changes to the even natural pace after the last credit.
The reference simulator keeps the burst rate throughout.

## Later tasks

Add the CLI and JSON output in a later task.
Add settings and the Analytics chart in a later task.
Add plan history and re-planning in a later task.
Re-plan on each quota tick and on credit list changes.
Record an observed reset when usage drops by more than 30 points.
Re-plan after an announced or observed reset.
Add the fleet lane text and bulletin guidance in a later task.
Compare actual usage with the planned curve.
Add one Mailbox prompt when a credit is due or expires within 48 hours.
Show the actual usage and the planned application time in that prompt.
Add a warning 24 hours before expiry.
Mark a credit used only after confirmation or reset evidence.
The Owner applies it in the Codex app.
Herdr Boss never opens or changes `/usage`.
Add CLI docs and page help with those interfaces.
