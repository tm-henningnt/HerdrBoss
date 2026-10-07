// The one text of every setting that the Settings and Allocation pages show.
// The info popup, the Help panel guide, and the settings reference in docs/cli.md all come from this file.
// Write in ASD-STE100 Simplified Technical English: one idea per sentence, active voice.
// A setting id is the key in policy.json or config.json. A control without such a key has a short dotted name.
// `apply` is one of APPLY. `default` and `range` are text, because a setting can be blank or a list.

export const APPLY = {
  policy: 'Select Apply policy. The change takes effect at the next engine tick.',
  'lock-policy': 'Select Apply policy. Capacity and guard changes apply to the next admission attempt, including queued jobs. A queued ticket keeps its prediction and short-limit classification.',
  service: 'Select Save in the group. The change takes effect at once.',
  restart: 'Change it in config.json. Restart the service.',
  now: 'The change takes effect at once.',
  'saved-restart': 'Select Save in the group. Restart the service for the change to take effect.',
  'saved-factory-start': 'Select Save in the group. Each factory container applies the change at its next start.',
};

// The order of a group is the order on the page. `advanced` groups sit in the collapsed Advanced section.
export const SETTING_GROUPS = [
  {
    id: 'harnesses', title: 'Agent apps', advanced: false,
    controls: 'Which agent kinds and models workers may use, the preferred model of each kind, and which provider usage limit each model counts against.',
    affects: 'Workers and usage limits. Worker start and handover choose only from the models that you leave on.',
    safe: 'Safe to change at any time. A running worker keeps its model. A model that you switch off is not chosen again.',
    restart: 'No restart. Select Apply policy.',
  },
  {
    id: 'quotas', title: 'Provider usage limits', advanced: false,
    controls: 'How Herdr Boss paces each provider usage limit, the goal for each usage limit window, and the warning and critical levels.',
    affects: 'Usage limits and notices. Pacing changes which lanes say Use now and when a worker start is refused. The levels change when a usage limit notice is sent.',
    safe: 'Safe to change. A goal below 100% makes Herdr Boss save usage limit. Keep the warning level below the critical level.',
    restart: 'No restart. Goals and modes need Apply policy. The two levels need Save.',
  },
  {
    id: 'machine', title: 'Machine', advanced: false,
    controls: 'The machine guard, the CPU and load limits, the disk and swap thresholds, and the notice cooldown.',
    affects: 'The machine and notices. An active guard blocks new workers when the machine is busy. Disk and swap thresholds raise notices. The swap refusal can block worker starts.',
    safe: 'Safe to change. A high limit lets more work run at once. A low limit protects the machine but slows work. Disk and swap notices stay on when the guard is off.',
    restart: 'No restart. Select Apply policy.',
  },
  {
    id: 'locks', title: 'Locks', advanced: false,
    controls: 'Machine lock capacity, the short job limit, and the machine guard for a short job that starts beside a long job.',
    affects: 'All projects that use a machine lock. The long lane always holds at most one job.',
    safe: 'Unknown jobs use the long lane. A lower limit sends more jobs to the long lane.',
    restart: 'No restart. Select Apply policy. The change applies to the next lock admission.',
  },
  {
    id: 'attachments', title: 'Pictures', advanced: false,
    controls: 'How many days Herdr Boss keeps pictures and agent messages. The time limit for a Herdr agent prompt process.',
    affects: 'Stored pictures, agent-message text, agent-message metadata, and prompt delivery.',
    safe: 'A shorter period deletes older pictures, message text, or metadata at the hourly sweep.',
    restart: 'No restart. Select Apply policy.',
  },
  {
    id: 'watch', title: 'Watch', advanced: false,
    controls: 'The routines that the Boss pane gets while a watch runs, the worker caps of a watch, and quiet hours.',
    affects: 'Workers and notices. A cap limits how many workers run while the Owner is away. A routine sends a prompt to the Boss pane.',
    safe: 'Safe to change. A routine change applies at the next prompt of a running watch. A routine that you edit never changes the kit file.',
    restart: 'No restart. A routine needs Save. A cap needs Save in its group.',
  },
  {
    id: 'capacity', title: 'Capacity and handover', advanced: false,
    controls: 'The number of working agents, idle sharing, the project lead reserve, and automatic handover of a project lead to a successor. These controls are on the Allocation page.',
    affects: 'Workers, usage limits, and handover. The maximum working agents is a hard cap for worker start. Handover moves a project lead to a fresh successor before a usage limit or context limit.',
    safe: 'Change the maximum working agents with care: a high value adds load. Leave automatic handover off until you have read the handover guide.',
    restart: 'No restart. Select Apply policy.',
  },
  {
    id: 'pools', title: 'Resource pools', advanced: false,
    controls: 'The ports of a pool, the split between projects, the wait default, and the client values by port. The idle time decides when Herdr Boss reclaims a lease. These controls are in the pools editor on the Settings page and on the Allocation page.',
    affects: 'Projects and workers that lease a port. A port that has no listener for the idle time goes back to the pool.',
    safe: 'Safe to change. A save never drops a port that a holder uses. A client value is stored in the private config file only.',
    restart: 'No restart. A save takes effect at once.',
  },
  {
    id: 'prices', title: 'Token prices', advanced: true,
    controls: 'The USD price per million tokens of each model.',
    affects: 'Only the cost figures on the Analytics page. No price changes how workers run.',
    safe: 'Safe to change. Reset to defaults removes all your changes.',
    restart: 'No restart. Select Save prices.',
  },
  {
    id: 'avatars', title: 'Avatars', advanced: true,
    controls: 'The image of the Boss and of each project in the Chat, the Mailbox, and the Agents chart.',
    affects: 'Only how the pages look.',
    safe: 'Safe to change.',
    restart: 'No restart. An upload or a reset takes effect at once.',
  },
  {
    id: 'service', title: 'Service settings', advanced: true,
    controls: 'The values that the service uses: collection intervals, worker clean-up, browser clean-up, release repositories, and the network address. Each row shows its source.',
    affects: 'Workers, notices, browsers, release approval, and the machine. A value here changes when a worker pane closes, a done worker is reported, or an idle browser closes.',
    safe: 'A row with an input is safe to change. A row without an input is read-only. Change it in config.json.',
    restart: 'The push row needs a service restart. Other rows with inputs apply after Save. A read-only row needs a service restart.',
  },
  {
    id: 'quota-plan', title: 'Usage limit plan', advanced: true,
    controls: 'The Codex reset credit plan, Owner prompts, expiry notices, and usage curve.',
    affects: 'Usage limit plan guidance, Mailbox items, and expiry notices. It does not change worker starts or apply a credit.',
    safe: 'Safe to change. Herdr Boss shows estimates and never applies a reset credit.',
    restart: 'No restart. Select Save in Usage limit plan settings.',
  },
  {
    id: 'analytics', title: 'Analytics', advanced: true,
    controls: 'Whether the service reads GitHub Actions minutes for registered repositories.',
    affects: 'Only the GitHub Actions minutes card on the Analytics page.',
    safe: 'Safe to change. Turn it off to stop GitHub API calls.',
    restart: 'No restart. Select Save in the group.',
  },
  {
    id: 'readiness', title: 'Agent app readiness', advanced: true,
    controls: 'A read-only table that shows if each agent app entry that orchestration needs is present.',
    affects: 'Nothing. The table only reports.',
    safe: 'Nothing to change. Run herdr-boss harness sync to see what to fix.',
    restart: 'No restart.',
  },
];

const S = (group, id, label, fields) => [id, { group, label, ...fields }];

export const SETTING_HELP = Object.fromEntries([
  // Harnesses
  S('harnesses', 'harness.available', 'Available', {
    what: 'Lets workers use this agent app. Clear it to stop all workers from using the agent app.',
    default: 'On for every agent app', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on lets worker start and handover pick the agent app.',
    lower: 'Turning it off stops new workers on this agent app. A running worker keeps working.',
    apply: 'policy',
  }),
  S('harnesses', 'harness.preferredModel', 'Preferred model', {
    what: 'The model that worker start and handover use when no model is given.',
    default: 'The agent app default', unit: 'Model name', range: 'Any model that the agent app allows',
    raise: 'Not applicable. Choose another model to change the choice.',
    lower: 'An empty choice uses the agent app default.',
    apply: 'policy',
  }),
  S('harnesses', 'harness.model', 'Model box', {
    what: 'Lets this agent app use the model. Clear the box to stop the agent app from using the model.',
    default: 'On for a catalog model', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on lets workers use the model in this agent app.',
    lower: 'Turning it off stops new workers on this model in this agent app. Other agent apps keep their own box.',
    apply: 'policy',
  }),
  S('harnesses', 'harness.provider', 'Provider', {
    what: 'The provider usage limit that this model counts against.',
    default: 'The route of the catalog, or Unmetered', unit: 'Provider name', range: 'The providers that the agent app supports, or Unmetered',
    raise: 'Not applicable. Choose a provider to count the model against its usage limit.',
    lower: 'Unmetered means no usage limit applies. Pacing and usage limit warnings ignore the model.',
    apply: 'policy',
  }),
  S('harnesses', 'harness.addModel', 'Add model', {
    what: 'Adds a local model string to this agent app. The string is stored in the local policy, not in kit/models.json.',
    default: 'No local models', unit: 'Model string', range: 'Up to 128 characters: letters, digits, dot, underscore, slash, and hyphen',
    raise: 'Not applicable.',
    lower: 'Select Remove to delete a local model.',
    apply: 'policy',
  }),

  // Provider quotas
  S('quotas', 'quota.mode', 'Usage limit mode', {
    what: 'Sets if Herdr Boss paces a provider. Manage pace uses the usage limit to decide when to run work. Ignore usage limit stops pacing and pace warnings for worker dispatch.',
    default: 'Manage pace', unit: 'Choice', range: 'Manage pace or Ignore usage limit',
    raise: 'Not applicable.',
    lower: 'Ignore usage limit lets workers start at any pace. Handover risk and automatic handover still use live usage limit data. A window at 100% still exhausts the provider.',
    apply: 'policy',
  }),
  S('quotas', 'quota.goalPercent', 'Pacing goal and goal end', {
    what: 'The most percent of a usage limit window that Herdr Boss plans to use by the end of the goal. The goal end is at the reset, at a local date and time, or a whole number of hours before each reset.',
    default: 'Blank, which means 100%', unit: 'Percent of the window', range: '0 to 100. A goal end must be after now, after the window start, and not after the reset',
    raise: 'A higher goal lets workers use more of the window. A later end gives the goal more time to use usage limit.',
    lower: 'A lower goal saves usage limit. The lanes say Use now less often. An earlier end forces the use of usage limit sooner.',
    apply: 'policy',
  }),
  S('quotas', 'paceTolerancePoints', 'Pace tolerance points', {
    what: 'The most percentage points that the use may be above the expected use of a usage limit window. Above this, the lane is ahead of pace. A lane inside the tolerance is on pace.',
    default: '5', unit: 'Percentage points', range: '0 to 50',
    raise: 'A lane stays on pace with a larger lead. Workers start more often.',
    lower: 'A lane is ahead of pace sooner. A value of 0 uses no tolerance.',
    apply: 'policy',
  }),
  S('quotas', 'paceMinUsePercent', 'Minimum use for ahead of pace', {
    what: 'The lane is never ahead of pace below this used percent of a usage limit window. This holds also when the use is above the expected use.',
    default: '30', unit: 'Percent used', range: '0 to 100',
    raise: 'A lane stays on pace to a higher use. A fresh window does not block workers.',
    lower: 'A lane can be ahead of pace at a lower use. A value of 0 uses no minimum.',
    apply: 'policy',
  }),
  S('quotas', 'paceRouting', 'Route to a below-pace lane', {
    what: 'Chooses a model of a lane that is far below its pace when you give no model. A lane is far below its pace when every live window is more than the tolerance below its expected use. The choice keeps the agent app and never overrides --kind or --model.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on uses the usage limit of a lane that is behind its pace.',
    lower: 'Turning it off keeps the default model of the agent app.',
    apply: 'policy',
  }),
  S('quotas', 'quotaProbe.backoffAfterTimeouts', 'Claude timeouts before back-off', {
    what: 'The number of Claude usage limit probe timeouts in a row after which Herdr Boss probes Claude at the back-off interval. A good reading resets the count. A timed-out probe is not retried at once. A missing usage reader or login is an unknown reading and does not count as a timeout.',
    default: '2', unit: 'Timeouts', range: '1 to 10',
    raise: 'A higher value keeps the normal probe interval for more timeouts.',
    lower: 'A lower value starts the back-off sooner.',
    apply: 'policy',
  }),
  S('quotas', 'quotaProbe.backoffMinutes', 'Claude back-off minutes', {
    what: 'The time between Claude usage limit probes after the timeouts in a row reach the limit. Codex and OpenCode Go keep the normal interval. The last good Claude reading stays on screen with its age.',
    default: '20', unit: 'Minutes', range: '1 to 1440',
    raise: 'A higher value probes Claude less often during a failure.',
    lower: 'A lower value probes Claude more often during a failure and adds load.',
    apply: 'policy',
  }),
  S('quotas', 'quota.warnPercent', 'Usage limit warning level', {
    what: 'The used percent of a usage limit window at which the usage limit shows a warning.',
    default: '90', unit: 'Percent used', range: '50 to 99, below the critical level',
    raise: 'A higher value gives the warning later.',
    lower: 'A lower value gives the warning earlier.',
    apply: 'service',
  }),
  S('quotas', 'quota.criticalPercent', 'Usage limit critical level', {
    what: 'The used percent of a usage limit window at which the usage limit shows a critical alert.',
    default: '98', unit: 'Percent used', range: '51 to 100, above the warning level',
    raise: 'A higher value gives the critical alert later.',
    lower: 'A lower value gives the critical alert earlier. Keep it above the warning level.',
    apply: 'service',
  }),
  S('quotas', 'quota.opencodeGoResetAt', 'OpenCode Go reset time', {
    what: 'The time at which the OpenCode Go subscription period resets. OpenCode Go has no usage source that Herdr Boss can read, so you set the time by hand. The Fleet page and the usage limit card show it next to the unknown reading. It gives a reset time and no percent.',
    default: 'Blank', unit: 'Time', range: 'Blank, or an ISO time such as 2026-10-09T10:00:00Z',
    raise: 'A later time shows a later reset.',
    lower: 'A blank value shows no reset time. The OpenCode Go reading stays unknown.',
    apply: 'service',
  }),
  S('quotas', 'quota.opencodeStatsDays', 'OpenCode Go estimate days', {
    what: 'The number of days that the local estimate of OpenCode Go use covers. The estimate comes from opencode stats, which counts the sessions in this factory only. It shows tokens and cost, labeled used in this factory (local estimate). It is never a percent and never a usage limit.',
    default: '7', unit: 'Days', range: 'A whole number of 1 to 90',
    raise: 'A higher value counts more days of local use.',
    lower: 'A lower value counts fewer days of local use.',
    apply: 'service',
  }),

  // Machine
  S('machine', 'machine.guardEnabled', 'Machine guard', {
    what: 'Turns the CPU and load limits on or off. An active guard warns and blocks worker starts when the machine is busy.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on protects the machine from too many workers.',
    lower: 'Turning it off stops CPU and load warnings and blocks. Memory, disk, and swap notices stay on.',
    apply: 'policy',
  }),
  S('machine', 'machine.guardPause', 'Pause guard', {
    what: 'Turns the machine guard off for a set time. The guard turns on again when the time ends.',
    default: '1 hour in the list', unit: 'Hours', range: '1, 2, 4, 8, 12, or 24 hours',
    raise: 'A longer pause lets more work run for longer.',
    lower: 'A shorter pause returns the protection sooner. Select Resume guard to end a pause early.',
    apply: 'policy',
  }),
  S('machine', 'machine.ownerAwayMinutes', 'Owner away after minutes', {
    what: 'The idle time after which Herdr Boss treats the Owner as away. It chooses the away limits below.',
    default: '10', unit: 'Minutes', range: '0 to 1440',
    raise: 'The Owner counts as present for longer, so the lower present limits apply for longer.',
    lower: 'The Owner counts as away sooner, so the higher away limits apply sooner.',
    apply: 'policy',
  }),
  S('machine', 'machine.presentCpuPercent', 'CPU limit while present', {
    what: 'The CPU use at which the guard blocks worker starts while the Owner is present. CPU is a percent of the total machine capacity.',
    default: '70', unit: 'Percent', range: '0 to 100',
    raise: 'A higher limit lets workers start on a busier machine.',
    lower: 'A lower limit keeps the machine free for the Owner.',
    apply: 'policy',
  }),
  S('machine', 'machine.awayCpuPercent', 'CPU limit while away', {
    what: 'The CPU use at which the guard blocks worker starts while the Owner is away.',
    default: '95', unit: 'Percent', range: '0 to 100, or blank to turn the limit off',
    raise: 'A higher limit lets workers use more of the machine.',
    lower: 'A lower limit leaves more headroom. A blank field turns the limit off.',
    apply: 'policy',
  }),
  S('machine', 'machine.presentLoadFactor', 'Present load backstop', {
    what: 'A backstop on the 5-minute load average while the Owner is present. The limit is this factor times the core count.',
    default: '3', unit: 'Times the core count', range: '0 to 128, or blank to turn the backstop off',
    raise: 'A higher factor allows more load before the guard acts.',
    lower: 'A lower factor acts sooner. A blank field turns the backstop off.',
    apply: 'policy',
  }),
  S('machine', 'machine.awayLoadFactor', 'Away load backstop', {
    what: 'A backstop on the 5-minute load average while the Owner is away. The limit is this factor times the core count.',
    default: '8', unit: 'Times the core count', range: '0 to 128, or blank to turn the backstop off',
    raise: 'A higher factor allows more load before the guard acts.',
    lower: 'A lower factor acts sooner. A blank field turns the backstop off.',
    apply: 'policy',
  }),
  S('machine', 'machine.diskWarnFreeGB', 'Disk warning at free GB or less', {
    what: 'The free disk space at or below which Herdr Boss raises the disk warning. A GB is 2³⁰ bytes. This notice stays on when the guard is off.',
    default: '20', unit: 'GB free', range: '0 to 1048576',
    raise: 'A higher value gives the warning earlier.',
    lower: 'A lower value gives the warning later.',
    apply: 'policy',
  }),
  S('machine', 'machine.diskClearFreeGB', 'Disk warning clears at free GB', {
    what: 'The free disk space at or above which the disk warning clears. The warning raises at the warning value or less and stays active until the free space reaches this value. A GB is 2³⁰ bytes.',
    default: '24', unit: 'GB free', range: '0 to 1048576, at least the warning value',
    raise: 'A higher value keeps the warning active longer and gives fewer repeat notices when the free space moves around the warning value.',
    lower: 'A lower value clears the warning sooner. A value near the warning value allows repeat notices.',
    apply: 'policy',
  }),
  S('machine', 'machine.diskCriticalFreeGB', 'Disk critical below free GB', {
    what: 'The free disk space below which Herdr Boss sends a critical disk alert.',
    default: '5', unit: 'GB free', range: '0 to 1048576',
    raise: 'A higher value gives the critical alert earlier.',
    lower: 'A lower value gives the critical alert later. Keep it below the warning value.',
    apply: 'policy',
  }),
  S('machine', 'machine.swapWarnPercent', 'Swap warning at % used', {
    what: 'The swap use at which Herdr Boss raises a swap warning. It needs 3 samples in a row at or above the percent, with at least the minimum GB in use. The warning never blocks work.',
    default: '80', unit: 'Percent of the swap total', range: '1 to 100, or blank to turn the warning off',
    raise: 'A higher value gives the warning later.',
    lower: 'A lower value gives the warning earlier. A blank field turns the warning off.',
    apply: 'policy',
  }),
  S('machine', 'machine.swapRefusePercent', 'Swap refusal at % used', {
    what: 'The swap use at which the swap refusal blocks new work. It has an effect only when Refuse new work at high swap is on.',
    default: '95', unit: 'Percent of the swap total', range: '1 to 100, or blank to turn the refusal off',
    raise: 'A higher value blocks new work later.',
    lower: 'A lower value blocks new work sooner. A blank field turns the refusal off.',
    apply: 'policy',
  }),
  S('machine', 'machine.swapMinUsedGB', 'Swap rules need at least GB used', {
    what: 'The least swap in use before the swap warning and the swap refusal apply. The macOS swap total grows with use, so a percent alone can mislead.',
    default: '2', unit: 'GB', range: '0 to 1024',
    raise: 'A higher value ignores a small swap use.',
    lower: 'A lower value lets a small swap use raise a notice. Zero removes the floor.',
    apply: 'policy',
  }),
  S('machine', 'machine.swapRefuseEnabled', 'Refuse new work at high swap', {
    what: 'When on, a worker start, a suite, or a push with a pre-push suite fails while swap is at or above the refusal percent. Work that the Owner or the Boss starts is never refused.',
    default: 'Off', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on protects a machine that swaps from more load. Use --force-swap, or HERDR_BOSS_FORCE_SWAP=1 for suite and push, to override.',
    lower: 'Turning it off lets work start at any swap level. The swap warning still applies.',
    apply: 'policy',
  }),
  S('machine', 'machine.alertCooldownSeconds', 'Notice cooldown seconds', {
    what: 'The least time before the same machine notice is sent again.',
    default: '21600 (6 hours)', unit: 'Seconds', range: '0 to 604800',
    raise: 'A higher value sends fewer repeat notices.',
    lower: 'A lower value sends repeat notices sooner. Zero sends a notice at each change.',
    apply: 'policy',
  }),
  S('machine', 'machine.kitDigestMinutes', 'Kit digest interval minutes', {
    what: 'The least time between two kit digests to one project lead pane. A digest lists the required kit changes that the pane has not received. Herdr Boss sends no digest while the pane works. It sends the digest when the pane is idle or done.',
    default: '120 (2 hours)', unit: 'Minutes', range: '10 to 1440',
    raise: 'A higher value sends fewer kit digests. Each digest lists more changes.',
    lower: 'A lower value sends kit digests sooner. Each digest lists fewer changes.',
    apply: 'policy',
  }),
  S('machine', 'machine.memFreeWarnPercent', 'Memory free warning', {
    what: 'The free memory percent below which Herdr Boss shows a memory warning. It stays on when the guard is off.',
    default: '15', unit: 'Percent free', range: '1 to 50',
    raise: 'A higher value gives the memory warning earlier.',
    lower: 'A lower value gives the memory warning later.',
    apply: 'service',
  }),

  S('attachments', 'attachments.retentionDays', 'Picture retention days', {
    what: 'How long Herdr Boss keeps a linked picture. An hourly sweep removes expired pictures. An upload left unlinked for one hour is deleted. Deleting or dismissing a message deletes its pictures.',
    default: '30', unit: 'Days', range: '1 to 365',
    raise: 'A higher value keeps linked pictures longer.',
    lower: 'A lower value deletes older pictures at the next sweep. Deleted pictures cannot be recovered.',
    apply: 'policy',
  }),
  S('attachments', 'agentMessages.retentionDays', 'Agent message text retention days', {
    what: 'How long Herdr Boss keeps agent-message text. An hourly sweep removes older text.',
    default: '14', unit: 'Days', range: '1 to 90',
    raise: 'A higher value keeps agent-message text longer.',
    lower: 'A lower value removes older text at the next sweep. Metadata rows use a separate retention setting.',
    apply: 'policy',
  }),
  S('attachments', 'agentMessages.metaRetentionDays', 'Agent message metadata retention days', {
    what: 'How long Herdr Boss keeps agent-message metadata after it removes the message text. A row has no message text.',
    default: '180', unit: 'Days', range: '7 to 730',
    raise: 'A higher value keeps message metadata longer.',
    lower: 'A lower value removes older metadata at the next sweep.',
    apply: 'policy',
  }),
  S('attachments', 'agentMessages.promptTimeoutSeconds', 'Agent prompt timeout', {
    what: 'The time limit for one Herdr agent prompt process. On a timeout, tell reads the pane input. If it equals the sent text, tell retries submit once. It clears only its own unsubmitted input while the agent is idle. Then it reads the pane again.',
    default: '25', unit: 'Seconds', range: '1 to 120',
    raise: 'A higher value gives Herdr more time to send a prompt. A blocked prompt delays the caller longer.',
    lower: 'A lower value ends a blocked prompt sooner. A slow delivery can time out.',
    apply: 'policy',
  }),

  // Locks
  S('locks', 'locks.slots', 'Machine lock slots', {
    what: 'The total number of holders for a machine lock. One holder uses the long lane. The other slots hold short jobs.',
    default: '2', unit: 'Slots', range: '1 to 4',
    raise: 'A higher value lets more short jobs run beside one long job.',
    lower: 'A lower value limits short jobs. Existing holders finish before admission fits the lower capacity. A value of 1 keeps one exclusive lane.',
    apply: 'lock-policy',
  }),
  S('locks', 'locks.shortLimitMinutes', 'Short job limit', {
    what: 'The hold time at or below which a job uses the short lane. Herdr Boss compares it with the median of fewer than 10 holds, or with the 90th percentile of the last 10 holds.',
    default: '6', unit: 'Minutes', range: '1 to 60',
    raise: 'A higher value sends more jobs to the short lane.',
    lower: 'A lower value sends more jobs to the long lane.',
    apply: 'lock-policy',
  }),
  S('locks', 'locks.guard.enabled', 'Guard for short jobs', {
    what: 'Checks machine load, swap use, and free memory before a short job starts beside a long job.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on pauses a short job when a machine limit fails.',
    lower: 'Turning it off lets a short job start beside a long job without a machine check.',
    apply: 'lock-policy',
  }),
  S('locks', 'locks.guard.maxLoadPercent', 'Maximum load for a short job', {
    what: 'The 5-minute load average as a percent of the machine core count. The guard pauses above this value. A queued short job shows `waits: lane guard` and the load in the Locks panel.',
    default: '231', unit: 'Percent of cores', range: '0 to 1000; a blank field is invalid',
    raise: 'A higher value lets a short job start at a higher load.',
    lower: 'A lower value pauses short jobs at a lower load.',
    apply: 'lock-policy',
  }),
  S('locks', 'locks.guard.maxSwapPercent', 'Maximum swap for a short job', {
    what: 'The swap use as a percent of the swap total. The guard pauses above this value.',
    default: '96', unit: 'Percent of swap', range: '0 to 100; a blank field is invalid',
    raise: 'A higher value lets a short job start with more swap in use.',
    lower: 'A lower value pauses short jobs with less swap in use.',
    apply: 'lock-policy',
  }),
  S('locks', 'locks.guard.minFreeMemPercent', 'Minimum free memory', {
    what: 'The free memory percent below which the guard pauses a short job.',
    default: '40', unit: 'Percent free', range: '0 to 100; a blank field is invalid',
    raise: 'A higher value leaves more memory free before a short job starts.',
    lower: 'A lower value lets a short job start with less free memory.',
    apply: 'lock-policy',
  }),

  // Watch
  S('watch', 'watch.routine.title', 'Routine title', {
    what: 'The name of a watch routine. The Watch box and the Boss prompt show it.',
    default: 'The kit title', unit: 'Text', range: 'Up to 60 characters',
    raise: 'Not applicable.', lower: 'Not applicable.',
    apply: 'now',
  }),
  S('watch', 'watch.routine.model', 'Routine model hint', {
    what: 'A hint of the model that the Boss should use for the routine. The Boss pane reads it in the prompt.',
    default: 'default', unit: 'Text', range: 'Up to 40 characters',
    raise: 'Not applicable.', lower: 'Not applicable.',
    apply: 'now',
  }),
  S('watch', 'watch.routine.schedule', 'Routine schedule', {
    what: 'When a routine runs during a watch: every N minutes, or at a set time before the end of the watch.',
    default: 'Every 60 minutes for a new routine', unit: 'Minutes, or a time of day', range: '1 to 1440 minutes, or a time such as 01:00',
    raise: 'More minutes between runs send fewer prompts.',
    lower: 'Fewer minutes between runs send more prompts and use more usage limit.',
    apply: 'now',
  }),
  S('watch', 'watch.routine.prompt', 'Routine prompt', {
    what: 'The text that the service sends to the Boss pane when the routine runs.',
    default: 'The kit text', unit: 'Text', range: 'Up to 8000 characters',
    raise: 'A longer prompt gives more detail and uses more context.',
    lower: 'Reset to the kit text removes your change.',
    apply: 'now',
  }),
  S('watch', 'watch.maxWorkers', 'Watch worker cap', {
    what: 'The most workers that run at the same time while a watch runs. A blank value uses the day value.',
    default: 'Blank (the day value)', unit: 'Workers', range: '1 to 40, or blank',
    raise: 'A higher cap runs more workers overnight and uses more usage limit and CPU.',
    lower: 'A lower cap runs fewer workers overnight.',
    apply: 'service',
  }),
  S('watch', 'watch.maxWorkersByLane', 'Watch worker cap by lane', {
    what: 'The most workers per lane while a watch runs. The lanes are Unmetered, Codex, Claude, and OpenCode Go. A blank lane uses the day value.',
    default: 'All lanes blank', unit: 'Workers', range: '1 to 40 for each lane, or blank',
    raise: 'A higher cap lets that lane run more workers.',
    lower: 'A lower cap protects the usage limit of that lane.',
    apply: 'service',
  }),
  S('watch', 'watch.quietHours', 'Quiet hours default', {
    what: 'The default for a new watch: quiet hours on or off. Quiet hours queue desktop notifications until the watch ends. They also delay the release of an expired manual suite lock or lease.',
    default: 'Off', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on gives a new watch quiet hours. A watch that you start can override it.',
    lower: 'Turning it off gives a new watch normal desktop notifications.',
    apply: 'service',
  }),

  // Capacity and handover (Allocation page)
  S('capacity', 'maxWorkers', 'Maximum working agents', {
    what: 'The most agents that work at the same time. The worker command enforces it for all projects together.',
    default: '8', unit: 'Agents', range: '1 to 64',
    raise: 'A higher value runs more work at once and adds CPU and usage limit use.',
    lower: 'A lower value queues new workers until a slot is free.',
    apply: 'policy',
  }),
  S('capacity', 'borrowIdle', 'Borrow idle shares', {
    what: 'Lets a busy project use the unused share of an idle project.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on uses the whole capacity when some projects are idle.',
    lower: 'Turning it off keeps each project inside its own share.',
    apply: 'policy',
  }),
  S('capacity', 'idleMinutes', 'Idle after minutes', {
    what: 'The time without activity after which a project counts as idle and lends its share.',
    default: '15', unit: 'Minutes', range: '0 to 1440',
    raise: 'A project stays active longer before it lends its share.',
    lower: 'A project lends its share sooner.',
    apply: 'policy',
  }),
  S('capacity', 'reservePercent', 'Project lead reserve', {
    what: 'The percent of a provider usage limit that is kept for project leads. Workers cannot use it.',
    default: '15', unit: 'Percent of the usage limit', range: '0 to 80',
    raise: 'A higher reserve keeps project leads running longer when usage limit is short. Workers get less.',
    lower: 'A lower reserve gives workers more usage limit. A project lead can run out first.',
    apply: 'policy',
  }),
  S('capacity', 'handoffLeadMinutes', 'Handover lead minutes', {
    what: 'A usage limit window is at risk when it will run out within this many minutes. Herdr Boss then recommends a handover.',
    default: '180', unit: 'Minutes', range: '0 to 10080',
    raise: 'A higher value recommends a handover earlier.',
    lower: 'A lower value recommends a handover later.',
    apply: 'policy',
  }),
  S('capacity', 'autoHandover', 'Automatic handover', {
    what: 'Lets Herdr Boss prepare and activate a successor project lead without the Owner. It never runs for the Boss. It never runs for a project that no longer works or that is paused or stood down. It never runs for a successor model that is weaker than the source. After activation, Herdr Boss closes the old pane when the successor has answered and the old pane is idle.',
    default: 'Off', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on moves a project lead to a successor at the reserve limit or the context limit.',
    lower: 'Turning it off means only the Owner starts a handover.',
    apply: 'policy',
  }),
  S('capacity', 'autoHandoverPercent', 'Activate at usage limit used %', {
    what: 'The usage limit level at which the prepared successor takes control. Boss prepares the successor at the reserve limit. The source stays in control until the successor reports ready and the usage limit reaches this level.',
    default: '98', unit: 'Percent of the usage limit', range: '90 to 100',
    raise: 'A higher value keeps the source in control for longer.',
    lower: 'A lower value hands over sooner.',
    apply: 'policy',
  }),
  S('capacity', 'autoHandoverContextTokens', 'Hand over at context tokens', {
    what: 'The context size above which a Claude project lead gets a fresh successor at a task boundary. The successor starts from the project memory file with the same model. Herdr Boss activates it when the project lead pane is not working. It reads the context size only for Claude. It compares a token count with this value, not a percent of the model window. A pane that it sees for the first time waits for its next boundary.',
    default: '300000', unit: 'Tokens', range: '50000 to 2000000',
    raise: 'A higher value keeps a long context for longer.',
    lower: 'A lower value hands over sooner and keeps the context short.',
    apply: 'policy',
  }),
  S('capacity', 'autoHandoverForceContextTokens', 'Force handover at context tokens', {
    what: 'The context size above which Herdr Boss asks a Claude project lead to update and commit project memory before it prepares a fresh successor. It prepares the successor after the commit or after 20 minutes. After a timeout, it cannot activate until it verifies a later memory commit. The successor uses the same model. Herdr Boss activates it when the project lead pane is idle or done. This value must be higher than Hand over at context tokens.',
    default: '400000', unit: 'Tokens', range: '50000 to 2000000',
    raise: 'A higher value gives the source more time before a forced handover.',
    lower: 'A lower value asks for a memory update sooner.',
    apply: 'policy',
  }),
  S('capacity', 'goals.autoCommand', 'Automatic Claude goal command', {
    what: 'Lets Herdr Boss send /goal automatically when it gives an Owner goal to a Claude agent. When this is off, Herdr Boss sends the goal as plain text. Manual herdr-boss goal set still sends /goal.',
    default: 'Off', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on lets a Claude agent set the Owner goal as an active goal.',
    lower: 'Turning it off sends the Owner goal as plain text.',
    apply: 'policy',
  }),
  S('capacity', 'opus.allowWithoutForce', 'Allow Opus without --force', {
    what: 'Lets `herdr-boss worker start` start a Claude Opus worker without `--force`. Turn it on only when the Owner approves Opus for workers. The Boss gets an alert for each Opus start. A refused start names this setting.',
    default: 'Off', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on lets each Opus start pass while the number of running Opus workers is below the limit.',
    lower: 'Turning it off means each Opus start needs `--force` and the Owner\'s approval.',
    apply: 'policy',
  }),
  S('capacity', 'opus.maxConcurrent', 'Running Opus workers at most', {
    what: 'The most Opus workers that can run at the same time when Opus starts without `--force`. A start at the limit is refused and names this setting. `--force` skips the limit.',
    default: '2', unit: 'Workers', range: '1 to 8',
    raise: 'A higher value allows more Opus workers at the same time and uses the Opus usage limit faster.',
    lower: 'A lower value refuses an Opus start sooner. Running Opus workers continue.',
    apply: 'policy',
  }),
  S('capacity', 'defaultOrchestratorGoal', 'Default project lead goal', {
    what: 'The goal text for a new project lead that has no goal. A handover copies the goal of the old project lead to the successor: the published status goal, else the last /goal command of its session. Claude gets plain text by default. Turn on Automatic Claude goal command to send /goal after activation. The default text ends with a rule: a running worker, a gate, a push, or a lock wait is progress. The rule stops the goal check from looping while the project lead waits for a report. The Set goal dialog and `herdr-boss goal set` accept at most 2000 characters.',
    default: 'A standing goal text', unit: 'Text', range: 'One line of at most 4000 characters, or empty for no default',
    raise: 'A longer text gives more direction and uses more context.',
    lower: 'An empty text gives a new project lead no default goal.',
    apply: 'policy',
  }),

  S('capacity', 'bossRules', 'Boss rules', {
    what: 'The standing rules that Herdr Boss gives to every successor in the handover bootstrap prompt. The text is the Boss rules section of that prompt. Each prepared successor reads the section, so the Boss does not send the rules again. The other two generated sections are the pane map and the open items. The open items section keeps only the memory lines of the last 48 hours whose text names the Owner or the Boss. Every value in the sections is rendered on one line, so a value cannot forge a section heading. An empty text leaves the section out.',
    default: 'The standing rules of the fleet', unit: 'Text', range: 'One line of at most 1200 characters, or empty for no rules',
    raise: 'A longer text gives the successor more rules and uses more of the prompt.',
    lower: 'A shorter text leaves out the rules that you remove, and a text over 1200 characters is refused.',
    apply: 'policy',
  }),

  S('capacity', 'succession.ladder', 'Project lead succession', {
    what: 'The ordered list of kind, model, and effort choices that automatic handover tries. It skips the current provider, unavailable usage limits, and global or project exclusions.',
    default: 'The list in policy.json', unit: 'List of choices', range: 'Up to 20 choices',
    raise: 'A longer list gives automatic handover more successors to try.',
    lower: 'A shorter list can leave no successor. A choice outside the list is never selected automatically.',
    apply: 'policy',
  }),
  S('capacity', 'workspace.exclusion', 'Workspace projects', {
    what: 'Decides which live workspaces count as projects. Clear a workspace switch to include it as a project. The Boss workspace stays excluded while its pane is labelled boss.',
    default: 'Every workspace is a project, except the Boss workspace', unit: 'Switch for each workspace', range: 'On or off',
    raise: 'Switching a workspace on removes it from the projects and from the shares.',
    lower: 'Switching a workspace off makes it a project that takes part in the shares.',
    apply: 'policy',
  }),
  S('capacity', 'project.shares', 'Project shares', {
    what: 'The share of the working agents for each project. Drag a boundary in the bar: only the projects to its right rebalance. The labels show the set share and the effective slots. Shares are advisory. The worker command enforces the global cap. Apply policy asks for a confirmation when 3 or more shares change, and asks again when the total is not 100.',
    default: 'The shares in policy.json', unit: 'Percent of the working agents', range: '0 to 100, and all shares add up to 100 or less',
    raise: 'A larger share gives the project more slots when the machine is busy.',
    lower: 'A smaller share gives the project fewer slots. It can borrow idle shares of others when Borrow idle shares is on.',
    apply: 'policy',
  }),

  // Token prices
  S('prices', 'prices.input', 'Input price', {
    what: 'The price of input tokens. The cost that Herdr Boss shows is an API-price equivalent, because a subscription is not billed per token.',
    default: 'The catalog price', unit: 'USD per million tokens', range: '0 to 1000, or blank for the default',
    raise: 'A higher price raises the cost figures.', lower: 'A lower price lowers the cost figures.',
    apply: 'now',
  }),
  S('prices', 'prices.output', 'Output price', {
    what: 'The price of output tokens.',
    default: 'The catalog price', unit: 'USD per million tokens', range: '0 to 1000, or blank for the default',
    raise: 'A higher price raises the cost figures.', lower: 'A lower price lowers the cost figures.',
    apply: 'now',
  }),
  S('prices', 'prices.cacheRead', 'Cache read price', {
    what: 'The price of tokens that the provider reads from its cache.',
    default: 'The catalog price', unit: 'USD per million tokens', range: '0 to 1000, or blank for the default',
    raise: 'A higher price raises the cost figures.', lower: 'A lower price lowers the cost figures.',
    apply: 'now',
  }),
  S('prices', 'prices.cacheWrite', 'Cache write price, 5 minutes', {
    what: 'The price of tokens that the provider writes to a cache with a 5-minute life.',
    default: 'The catalog price', unit: 'USD per million tokens', range: '0 to 1000, or blank for the default',
    raise: 'A higher price raises the cost figures.', lower: 'A lower price lowers the cost figures.',
    apply: 'now',
  }),
  S('prices', 'prices.cacheWrite1h', 'Cache write price, 1 hour', {
    what: 'The price of tokens that the provider writes to a cache with a 1-hour life.',
    default: 'The catalog price', unit: 'USD per million tokens', range: '0 to 1000, or blank for the default',
    raise: 'A higher price raises the cost figures.', lower: 'A lower price lowers the cost figures.',
    apply: 'now',
  }),

  // Avatars
  S('avatars', 'avatar.upload', 'Avatar image and reset', {
    what: 'Sets your own image for the Boss or for a project. The Reset button removes your image and returns to the generated avatar.',
    default: 'A generated avatar', unit: 'Image file', range: 'PNG, JPEG, or WebP, at most 512 KB. Each row holds the avatar of the Boss or of a project. Herdr Boss keeps no other format',
    raise: 'Not applicable.', lower: 'Not applicable.',
    apply: 'now',
  }),

  // Resource pools (Settings page and Allocation page)
  S('pools', 'pool.ports', 'Ports of a pool', {
    what: 'The ports or items of the pool. Enter single ports, ranges such as 8000-8009, or a list of both.',
    default: 'None', unit: 'Ports', range: '1024 to 65535, at most 100 ports, no duplicate, not the dashboard port or a browser port',
    raise: 'A new range adds ports at once. No code change is needed.',
    lower: 'A port that a holder uses stays in the pool. Release the lease first, or wait for the idle time.',
    apply: 'now',
  }),
  S('pools', 'pool.idleMinutes', 'Idle minutes of a pool', {
    what: 'The minutes that a leased port can have no listener before Herdr Boss reclaims the lease. A holder gets one notice.',
    default: '20', unit: 'Minutes', range: '1 to 240',
    raise: 'A longer time gives a holder more time to start a server.',
    lower: 'A shorter time frees unused ports sooner.',
    apply: 'now',
  }),
  S('pools', 'pool.waitSeconds', 'Wait for a free item', {
    what: 'The seconds that lease acquire waits for a free item when the pool is full. The command --wait option overrides it.',
    default: '0', unit: 'Seconds', range: '0 to 3600',
    raise: 'A longer wait lets a caller queue for a free port. The queue serves callers in order.',
    lower: 'A shorter wait fails sooner when no item is free. Zero means no wait.',
    apply: 'now',
  }),
  S('pools', 'pool.portEnv', 'Values by port', {
    what: 'An environment variable with a value for each port range, for example a client ID. A lease hands the worker the value that matches its port.',
    default: 'None', unit: 'Text', range: 'Up to 200 characters, no whitespace',
    raise: 'Add a row to hand a value to the ports of a range.',
    lower: 'Enter an empty value to clear a stored value. A port without a value gets no variable.',
    apply: 'now',
  }),

  // Service settings
  S('service', 'worktreeRoot', 'Worktree root', {
    what: 'The parent folder for new worker worktrees. A project worktreeRoot in .herdr-boss.json takes precedence. Existing worktrees stay in place.',
    default: '~/Projects/.herdr-wt', unit: 'Path', range: 'An absolute path or a path that starts with ~. No .. segment, not /',
    raise: 'Set another folder for new worker worktrees. Run herdr-boss harness sync to check agent app access.',
    lower: 'The value does not move or delete existing worktrees.', apply: 'service',
  }),
  S('service', 'projectRoot', 'Project root', {
    what: 'The suggested group folder for New project in the dashboard. An entered group or exact path takes precedence.',
    default: '~/Projects', unit: 'Path', range: 'An absolute path or a path that starts with ~. No .. segment, not /',
    raise: 'Set another suggested group folder. The CLI still requires --group or --path.',
    lower: 'The value does not move or delete existing projects.', apply: 'service',
  }),
  S('service', 'staleStatusMinutes', 'Stale status minutes', {
    what: 'The age after which a published project status is stale while workers run or new commits land.',
    default: '120', unit: 'Minutes', range: '5 to 1440',
    raise: 'A higher value gives the stale notice later.',
    lower: 'A lower value gives the stale notice sooner.',
    apply: 'service',
  }),
  S('service', 'staleTextMinutes', 'Stale text minutes', {
    what: 'The time that a published phase or summary can keep the same text before the project lead gets a stale text notice. The project lead must rewrite the text at each publish.',
    default: '360', unit: 'Minutes', range: '5 to 10080',
    raise: 'A higher value sends the stale text notice later.',
    lower: 'A lower value sends the stale text notice sooner.',
    apply: 'service',
  }),
  S('service', 'workers.staleIdleMinutes', 'Stale idle worker minutes', {
    what: 'The idle time after which Herdr Boss reports a worker as stale. The wait command uses it as its stall time.',
    default: '120', unit: 'Minutes', range: '5 to 1440',
    raise: 'A higher value waits longer before it reports an idle worker.',
    lower: 'A lower value reports an idle worker sooner.',
    apply: 'service',
  }),
  S('service', 'workers.paneCloseDelayMinutes', 'Worker pane close delay', {
    what: 'The time after collection before Herdr Boss closes the worker pane. The service closes it after the command exits.',
    default: '2', unit: 'Minutes', range: '0 to 60',
    raise: 'A higher value leaves the pane open longer.',
    lower: 'A lower value closes the pane sooner. Zero closes it on the next service tick.',
    apply: 'service',
  }),
  S('service', 'worktrees.pruneAtCollect', 'Prune merged worktree at collect', {
    what: 'When on, worker collect archives the reports. It removes a worker worktree and branch only when the branch is merged. The generated kit file must not be staged. It must match the current kit or a version in the base branch history. The worktree must have no other dirty path, live pane, or blocking process.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on removes safe, merged worktrees after collection.',
    lower: 'Turning it off keeps worktrees for herdr-boss worktree prune.',
    apply: 'service',
  }),
  S('service', 'workers.uncollectedNoticeMinutes', 'Uncollected worker notice minutes', {
    what: 'The time that a worker can stay done without collection before the service tells its project lead.',
    default: '30', unit: 'Minutes', range: '1 to 1440',
    raise: 'A higher value sends the notice later.',
    lower: 'A lower value sends the notice sooner.',
    apply: 'service',
  }),
  S('service', 'workers.leaseGraceMinutes', 'Lease grace minutes', {
    what: 'The time that a lease of a pool with an idle rule can have no bound process and no listener. The service reclaims the lease after this time, also when the idle time of the pool is longer. A lease of a pool without an idle rule is not reclaimed by this time. A worker gives back its leases at collect and at park in any pool.',
    default: '30', unit: 'Minutes', range: '1 to 1440',
    raise: 'A higher value lets an unused lease stay longer.',
    lower: 'A lower value gives an unused lease back sooner.',
    apply: 'service',
  }),
  S('service', 'browsers.reapOrphanDaemons', 'Stop orphan browser daemons', {
    what: 'Lets Herdr Boss stop an agent-browser daemon that has no parent, no children, and the minimum age. It never stops a browser that it did not start.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on frees memory from forgotten daemons.',
    lower: 'Turning it off leaves orphan daemons running.',
    apply: 'service',
  }),
  S('service', 'browsers.orphanDaemonMinAgeSeconds', 'Orphan daemon minimum age', {
    what: 'The age that an orphan browser daemon must reach before Herdr Boss stops it.',
    default: '7200', unit: 'Seconds', range: '60 to 86400',
    raise: 'A higher value spares a young daemon for longer.',
    lower: 'A lower value stops orphans sooner and risks a daemon that is between two uses.',
    apply: 'service',
  }),
  S('service', 'browsers.staleOwnedMinutes', 'Stale owned browser minutes', {
    what: 'The idle time of the agent after which Herdr Boss reports its browser as stale.',
    default: '30', unit: 'Minutes', range: '5 to 1440',
    raise: 'A higher value reports a stale browser later.',
    lower: 'A lower value reports a stale browser sooner.',
    apply: 'service',
  }),
  S('service', 'browser.idleCloseMinutes', 'Project browser idle close minutes', {
    what: 'The time with no other CDP client or open agent tab before Herdr Boss closes a project browser that it started.',
    default: '20', unit: 'Minutes', range: '0 to 1440',
    raise: 'A higher value leaves an unused browser open longer.',
    lower: 'A lower value closes an unused browser sooner. Zero turns this rule off.',
    apply: 'service',
  }),
  S('service', 'chromePath', 'Chrome path', {
    what: 'The Chrome executable that Herdr Boss starts for a project browser. A running browser keeps its executable until it restarts.',
    default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', unit: 'Path', range: 'An absolute path or a path that starts with ~. No .. segment, not /',
    raise: 'Set the path of another Chrome or Chromium, for example the Linux path of a container.',
    lower: 'The profile folder of each project stays the same. A saved login stays in the profile.',
    apply: 'service',
  }),
  S('service', 'browsers.sweepCodeSignClones', 'Sweep code-sign clones', {
    what: 'Lets Herdr Boss delete old code-sign clones of Chrome that no running Chrome process owns.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on frees disk space.',
    lower: 'Turning it off leaves the clones on disk.',
    apply: 'service',
  }),
  S('service', 'factories.claudeUsageHelper', 'Claude usage helper in factories', {
    what: 'Lets a factory container show the Claude usage limit. The helper is the command herdr-boss claude-statusline. It is the status line of the factory user in Claude Code. It writes the two usage windows and the time to a private file in the factory data folder. It writes no other field of the status line input. The setting never changes the Claude settings on this Mac. The switch is read in the data folder of the factory. Set it in the Settings or the config.json of that factory. The value on this Mac does not reach a factory.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on shows the Claude usage limit of a factory while a Claude session runs there.',
    lower: 'Turning it off removes the status line entry of the factory user. The Claude usage limit of a factory then shows as unknown.',
    apply: 'saved-factory-start',
  }),
  S('service', 'tickSeconds', 'Tick seconds', {
    what: 'The time between two collection passes of the engine.',
    default: '30', unit: 'Seconds', range: 'A whole number of 5 to 300',
    raise: 'A higher value gives slower updates and less load.',
    lower: 'A lower value gives faster updates and more load.',
    apply: 'service',
  }),

  S('service', 'quotaSeconds', 'Usage limit seconds', {
    what: 'The time between two reads of the provider usage limits.',
    default: '300', unit: 'Seconds', range: 'A whole number of 30 to 3600',
    raise: 'A higher value reads usage limits less often.',
    lower: 'A lower value reads usage limits more often and calls the providers more.',
    apply: 'service',
  }),

  S('service', 'push', 'Push prompts', {
    what: 'Lets the service send prompts to project lead panes. Notices to the Owner are always sent. The environment variable HERDR_BOSS_PUSH=0 overrides the saved value. Restart the service after a change.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'Turning it on lets the service prompt the project leads.',
    lower: 'Turning it off stops all prompts to project lead panes.',
    apply: 'saved-restart',
  }),


  S('service', 'alertCooldownSeconds', 'Notice cooldown (legacy)', {
    what: 'An unused legacy value. Set the notice cooldown in the Machine group.',
    default: '21600 (6 hours)', unit: 'Seconds', range: 'Read-only',
    raise: 'No notice reads this value.',
    lower: 'No notice reads this value.',
    apply: 'restart',
  }),


  S('service', 'providerKinds', 'Provider kinds', {
    what: 'Maps each usage limit provider to the agent kinds that use it.',
    default: 'claude to claude, codex to codex, opencodego to opencode and pi', unit: 'Object of lists', range: 'Kind names that exist',
    raise: 'Not applicable.',
    lower: 'A wrong map counts a kind against the wrong usage limit.',
    apply: 'restart',
  }),
  S('service', 'orchestratorLabel', 'Project lead label', {
    what: 'The pane label that marks the project lead of a project.',
    default: 'orch', unit: 'Text', range: 'One pane label',
    raise: 'Not applicable.',
    lower: 'A wrong label makes Herdr Boss miss the project lead panes.',
    apply: 'restart',
  }),
  S('service', 'port', 'Port', {
    what: 'The port of the dashboard and the API.',
    default: '4477', unit: 'TCP port', range: '1 to 65535',
    raise: 'Not applicable.',
    lower: 'A change also changes the address that other tools use.',
    apply: 'restart',
  }),
  S('service', 'host', 'Host', {
    what: 'The network address that the server listens on. 0.0.0.0 allows remote access with the access token. 127.0.0.1 allows only this machine.',
    default: '0.0.0.0', unit: 'Address', range: 'An IP address of this machine',
    raise: 'Not applicable.',
    lower: 'Set 127.0.0.1 to turn remote access off.',
    apply: 'restart',
  }),
  S('service', 'allowedHosts', 'Allowed hosts', {
    what: 'Host names that the server accepts in addition to localhost, this machine, and names that end in .ts.net. Enter a name such as factory-two, *.localhost for each name below localhost, or *.example.test for each name below example.test. A wildcard needs two labels after *., except *.localhost. A port, an address, and a bare * are not allowed.',
    default: 'Empty list', unit: 'List of host names', range: 'Up to 50 names',
    raise: 'A request that names a listed host passes the host check. A request from another machine still needs the access token.',
    lower: 'Remove a name to refuse requests that use it.',
    apply: 'service',
  }),
  S('service', 'log.maxMegabytes', 'Log size limit', {
    what: 'The size at which the server log file service.log rotates. The server also writes the log to standard output.',
    default: '10', unit: 'Megabytes', range: '1 to 1000',
    raise: 'The log file holds more history and uses more disk space.',
    lower: 'The log file rotates sooner and holds less history.',
    apply: 'service',
  }),
  S('service', 'log.keepFiles', 'Old log files', {
    what: 'The number of rotated log files that Herdr Boss keeps, as service.log.1 and service.log.2.',
    default: '2', unit: 'Files', range: '1 to 2',
    raise: 'More history stays on disk.',
    lower: 'Herdr Boss deletes the older file at the next rotation.',
    apply: 'service',
  }),
  S('service', 'releases.repos', 'Allowed release repositories', {
    what: 'Limits release request and release publish to the repositories in this list. Each row gives the GitHub repository name, project slug, and release kind. The Owner must approve each request in the Mailbox before publish.',
    default: 'Empty list', unit: 'List of repositories', range: 'Unique GitHub repository names with a project slug and release kind',
    raise: 'Add a repository when a project lead needs to request a release.',
    lower: 'Remove a repository to refuse its release requests and publications.',
    apply: 'service',
  }),

  // Quota plan
  S('quota-plan', 'quotaPlan.burstPace', 'Burst pace', {
    what: 'The points per hour that a burst may use before the plan schedules a reset credit.',
    default: '1', unit: 'Percentage points per hour', range: '0.1 to 10',
    raise: 'A higher pace reaches the apply threshold sooner when demand stays the same.',
    lower: 'A lower pace reaches the apply threshold later.',
    apply: 'service',
  }),
  S('quota-plan', 'quotaPlan.applyThreshold', 'Credit apply threshold', {
    what: 'The used percent at which the plan may schedule a reset credit and ask the Owner to apply it.',
    default: '95', unit: 'Percent used', range: '50 to 100',
    raise: 'A higher threshold saves more usage limit before the planned reset.',
    lower: 'A lower threshold schedules the reset sooner.',
    apply: 'service',
  }),
  S('quota-plan', 'quotaPlan.margin', 'Reserve margin', {
    what: 'The percent points that the plan keeps below full usage limit use.',
    default: '0', unit: 'Percentage points', range: '0 to 50',
    raise: 'A higher margin lowers the effective credit apply threshold.',
    lower: 'A lower margin permits a higher apply threshold.',
    apply: 'service',
  }),
  S('quota-plan', 'quotaPlan.horizon', 'Planning horizon', {
    what: 'The time at which the plan stops. Use the last credit expiry or enter an ISO time.',
    default: 'last-expiry', unit: 'End time', range: 'last-expiry or an ISO time',
    raise: 'A later time includes more planned usage limit use.',
    lower: 'An earlier time limits the plan to a shorter period.',
    apply: 'service',
  }),
  S('quota-plan', 'quotaPlan.tolerance', 'Plan guidance tolerance', {
    what: 'The points above the planned curve that keep Codex out of hold guidance.',
    default: '5', unit: 'Percentage points', range: '0 to 50',
    raise: 'A higher tolerance lets actual use stay above the curve before the lane says hold.',
    lower: 'A lower tolerance makes the lane say hold after a smaller gap.',
    apply: 'service',
  }),
  S('quota-plan', 'quotaPlan.holdMargin', 'Hold margin', {
    what: 'The points that the hold state adds to the plan guidance tolerance, and subtracts from it to leave the hold.',
    default: '1', unit: 'Percentage points', range: '0 to 50',
    raise: 'A higher margin makes the hold enter later and leave later.',
    lower: 'A lower margin makes the hold follow the tolerance more closely.',
    apply: 'service',
  }),
  S('quota-plan', 'quotaPlan.planMode', 'Plan mode', {
    what: 'How the planned curve guides the Codex lane. Paced holds the lane when use is ahead of the curve by more than the tolerance. Burst gives the curve as advice only and keeps the lane at Use now.',
    default: 'paced', unit: 'Mode', range: 'paced or burst',
    raise: 'Burst stops the hold guidance. The lane shows the points ahead of the plan and the time at which the recent burn reaches the credit threshold.',
    lower: 'Paced enforces the curve in the guidance text and in the lane. Worker start rules do not change.',
    apply: 'service',
  }),
  S('quota-plan', 'quotaPlan.slowFactor', 'Slow scenario factor', {
    what: 'The fraction of the burst pace that the slow scenario uses.',
    default: '0.5', unit: 'Factor', range: '0.1 to 1',
    raise: 'A higher factor makes the slow scenario closer to the fast scenario.',
    lower: 'A lower factor gives the slow scenario a smaller burst pace.',
    apply: 'service',
  }),

  S('analytics', 'analytics.actionsMinutes', 'GitHub Actions minutes', {
    what: 'Lets the service read Actions run times for registered GitHub repositories. Minutes are estimated from run times.',
    default: 'On', unit: 'Switch', range: 'On or off',
    raise: 'The service uses its GitHub token. It skips repositories that the token cannot read.',
    lower: 'Turn it off to stop GitHub API calls. The Analytics page hides the card.',
    apply: 'service',
  }),

  // Harness readiness
  S('readiness', 'harness.readiness', 'Readiness table', {
    what: 'Shows for each agent app entry if it is ok, missing, or bad. The table shows no path and no value.',
    default: 'Not applicable', unit: 'Table', range: 'Read-only',
    raise: 'Not applicable.', lower: 'Not applicable.',
    apply: 'now',
  }),
]);

export const SETTING_FIELDS = ['what', 'default', 'unit', 'range', 'raise', 'lower', 'apply'];

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function settingHelp(id) {
  return SETTING_HELP[id] || null;
}

// The plain-text lines of one setting, as [label, text] pairs. The popup, the guide, and the docs use these.
export function settingLines(id) {
  const item = SETTING_HELP[id];
  if (!item) return [];
  return [
    ['What it does', item.what],
    ['Default', item.default],
    ['Unit', item.unit],
    ['Range', item.range],
    ['Raise it', item.raise],
    ['Lower it', item.lower],
    ['Apply', APPLY[item.apply]],
  ];
}

export function settingPopupHtml(id) {
  const lines = settingLines(id);
  if (!lines.length) return '';
  return `<dl class="setting-popup-list">${lines.map(([term, text]) => `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(text)}</dd></div>`).join('')}</dl>`;
}

// The high-level guide for the Help panel.
export function settingsGuideHtml() {
  const rows = SETTING_GROUPS.map((group) => `<h4>${escapeHtml(group.title)}${group.advanced ? ' (Advanced)' : ''}</h4>`
    + `<p><b>Controls:</b> ${escapeHtml(group.controls)}</p>`
    + `<p><b>Effect:</b> ${escapeHtml(group.affects)}</p>`
    + `<p><b>Safe to change:</b> ${escapeHtml(group.safe)}</p>`
    + `<p><b>Restart:</b> ${escapeHtml(group.restart)}</p>`).join('');
  return `<p>Select an <b>i</b> button to read what a setting does, its default, its unit, its range, and the effect of a higher or lower value. A setting that repeats in a section has one button on the section header, not one on each row. On a desktop, hold the pointer over the button. Press Escape to close the popup.</p>${rows}`;
}

export const DOCS_BEGIN = '<!-- settings-reference:begin -->';
export const DOCS_END = '<!-- settings-reference:end -->';

// The settings reference for docs/cli.md. A test compares this text with the file.
export function settingsDocsMarkdown() {
  const out = [DOCS_BEGIN, '', 'Do not edit this block. It comes from `public/setting-help.js`.', ''];
  for (const group of SETTING_GROUPS) {
    out.push(`#### ${group.title}${group.advanced ? ' (Advanced)' : ''}`, '');
    out.push(`- Controls: ${group.controls}`, `- Effect: ${group.affects}`, `- Safe to change: ${group.safe}`, `- Restart: ${group.restart}`, '');
    out.push('| Setting | Key | What it does | Default | Unit | Range | Raise it | Lower it | Apply |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [id, item] of Object.entries(SETTING_HELP)) {
      if (item.group !== group.id) continue;
      const cell = (text) => String(text).replace(/\|/g, '\\|');
      out.push(`| ${cell(item.label)} | \`${id}\` | ${cell(item.what)} | ${cell(item.default)} | ${cell(item.unit)} | ${cell(item.range)} | ${cell(item.raise)} | ${cell(item.lower)} | ${cell(APPLY[item.apply])} |`);
    }
    out.push('');
  }
  out.push(DOCS_END);
  return out.join('\n');
}
