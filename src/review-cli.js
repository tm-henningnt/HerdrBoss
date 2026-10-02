// The `herdr-boss review` commands. See docs/cli.md, section Review packs.
// Exit codes: 0 done, 1 usage or refusal (caller, secret in a note, quota, open pack limit), 2 the pack is not valid,
// 3 the pack or its result does not exist.
// Every function takes the environment, the Herdr runner, the data dir, and the time as options, so a test never reads the live data dir.
import crypto from 'node:crypto';
import { DATA_DIR, dashboardUrl, loadConfig } from './config.js';
import { SLUG } from './projects.js';
import { DEFAULT_LIMITS, itemHash, validatePack } from './review-pack.js';
import { buildImport, safeText } from './review-import.js';
import { publishVersion, getPack, getFile, packDirectory, getResultRecord, listPacks, deletePack, reopenItem, putAnswer, setMailId, ReviewStoreError } from './review-store.js';
import { resultMarkdown, verdictLabel } from './review-result.js';
import { verifyMessageCaller, readControl, readMessages, postReview, closeReviewItems, refuseSecret } from './messages.js';
import { PLANNER_LABEL, activeSessionForPane, setRound } from './planner-sessions.js';

export const EXIT = Object.freeze({ ok: 0, refused: 1, invalid: 2, missing: 3 });

const NOTE_MAX = 1000;
const STATES = ['open', 'done', 'all'];

const USAGE = {
  check: 'Usage: review check FOLDER',
  publish: 'Usage: review publish SLUG FOLDER [--note TEXT] [--round N] [--dry-run] [--carry-open]',
  import: 'Usage: review import SLUG FOLDER-OR-FILE [--id ID] [--title TEXT] [--dry-run]',
  result: 'Usage: review result [SLUG] PACK [--version N] [--format json|md]. PACK can also be SLUG/PACK. --json means --format json.',
  delete: 'Usage: review delete [SLUG] PACK. PACK can also be SLUG/PACK.',
  reopen: 'Usage: review reopen SLUG PACK ITEM',
  list: 'Usage: review list [SLUG] [--state open|done|all] [--json]',
};
const USAGE_ALL = `Usage: review check|publish|import|result|delete|reopen|list. Run herdr-boss with no command to see each form.`;

export class ReviewCliError extends Error {
  constructor(message, code = EXIT.refused) {
    super(message);
    this.exitCode = code;
  }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Parse `--flag VALUE` and `--switch` options. Each option appears at most once. Other tokens are positional.
function parse(args, { values = [], switches = [] }, usage) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    if (![...values, ...switches].includes(token)) throw new ReviewCliError(`Unknown option: ${token}. ${usage}`);
    if (token in flags) throw new ReviewCliError(`${token} may be used only once.`);
    if (switches.includes(token)) { flags[token] = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new ReviewCliError(`${token} needs a value.`);
    flags[token] = value;
  }
  return { flags, positional };
}

const checkSlug = (slug, usage) => {
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw new ReviewCliError(`The project slug must match [a-z0-9][a-z0-9-]* and have at most 64 characters. ${usage}`);
  return slug;
};

export const isPlainTerminal = (env) => env.HERDR_ENV !== '1' && !env.HERDR_PANE_ID && !env.HERDR_WORKSPACE_ID;

export const projectOf = (control, workspace) => Object.values(control?.projects || {}).find((project) => project?.workspace === workspace)?.slug ?? null;

// The caller rules of publish, import, and delete. Returns { role, from }.
// A plain terminal is the Owner and may name any slug. A pane goes through the same check as `say`: the label is boss or orch.
// An orch pane must name the slug of its own workspace. The boss pane must name the slug boss, its own thread.
// With `planner`, a pane labeled planner may call too. It needs an active planner session and must name the project of that session.
// The result then has role planner and the session.
export function verifyReviewCaller(command, slug, { env, herdr, control, dir }, { planner = false } = {}) {
  if (isPlainTerminal(env)) return { role: 'owner', from: 'orch' };
  const caller = verifyMessageCaller(env, herdr, command, { labels: planner ? ['boss', 'orch', PLANNER_LABEL] : ['boss', 'orch'] });
  if (caller.role === PLANNER_LABEL) {
    const session = activeSessionForPane({ dir, pane: caller.paneId });
    if (!session) throw new ReviewCliError(`The pane ${caller.paneId} is labeled ${PLANNER_LABEL} but has no active planner session. Ask the orchestrator to run herdr-boss plan start.`);
    if (session.project !== slug) throw new ReviewCliError(`This pane has a planner session for project ${session.project}. It can run herdr-boss ${command} only for the slug ${session.project}, not for ${slug}.`);
    return { role: 'planner', from: 'orch', session, planner: { session: session.id, pane: session.pane } };
  }
  if (caller.role === 'boss') {
    if (slug !== 'boss') throw new ReviewCliError(`The pane labeled boss can run herdr-boss ${command} only for the slug boss, not for ${slug}.`);
    return { role: 'boss', from: 'boss' };
  }
  const own = projectOf(control(), caller.workspaceId);
  if (!own) throw new ReviewCliError(`No project uses workspace ${caller.workspaceId}. Publish the project status, then wait for the next Herdr Boss tick.`);
  if (own !== slug) throw new ReviewCliError(`This pane belongs to project ${own}. It can run herdr-boss ${command} only for the slug ${own}, not for ${slug}.`);
  return { role: 'orch', from: 'orch' };
}

// SLUG PACK, SLUG/PACK, or PACK. A bare PACK uses the project of the workspace of the caller.
function resolvePack(positional, usage, { env, control }) {
  let slug;
  let pack;
  if (positional.length === 2) [slug, pack] = positional;
  else if (positional.length === 1 && positional[0].includes('/')) [slug, pack] = positional[0].split('/');
  else if (positional.length === 1) {
    slug = env.HERDR_WORKSPACE_ID ? projectOf(control, env.HERDR_WORKSPACE_ID) : null;
    pack = positional[0];
    if (!slug) throw new ReviewCliError(`${usage} This shell has no project workspace, so name the slug.`);
  } else throw new ReviewCliError(usage);
  checkSlug(slug, usage);
  if (typeof pack !== 'string' || !SLUG.test(pack)) throw new ReviewCliError(`The pack ID must match [a-z0-9][a-z0-9-]* and have at most 64 characters. ${usage}`);
  return { slug, pack };
}

// Print the errors of a validation. The messages name a file and a rule, never a value.
// The messages can hold a file name from the pack folder, so each one passes safeText().
function printErrors(validation, { err }) {
  for (const problem of validation.errors) err(`Error: ${safeText(problem.message, 500)}`);
}

function printWarnings(validation, { out }) {
  for (const warning of validation.warnings) out(`Warning: ${safeText(warning.message, 500)}`);
}

function reviewUrl(slug, pack, baseUrl) {
  const page = `/reviews/${slug}/${pack}`;
  if (baseUrl) return `${baseUrl}${page}`;
  try { return `${dashboardUrl(loadConfig())}${page}`; } catch { return page; }
}

const changeText = (published) => {
  const parts = [];
  if (published.version > 1) {
    if (published.changed.length) parts.push(`${plural(published.changed.length, 'item')} changed since v${published.version - 1}.`);
    if (published.added.length) parts.push(`${plural(published.added.length, 'item')} added.`);
    if (published.removed.length) parts.push(`${plural(published.removed.length, 'item')} removed.`);
  }
  return parts.join(' ');
};

// The Mailbox item of a stored version. A failure here leaves the stored pack without its item, so the message names the pack
// and the repair: the same publish command posts the missing item and makes no new version.
function postItem({ slug, pack, version, title, text, caller }, { dir, now, deps }) {
  try {
    const record = deps.postReview({ slug, pack, title, version, text, role: caller.from, planner: caller.planner }, { dir, now });
    deps.setMailId({ dir, slug, pack, mailId: record.id });
    return record;
  } catch (error) {
    throw new ReviewCliError(`The pack ${slug}/${pack} v${version} is stored, but Herdr Boss did not finish its Mailbox item: ${safeText(error?.message, 300)}. Run the same herdr-boss review publish command again. It posts the missing item and makes no new version.`);
  }
}

// An open pack whose content did not change is not published again. The command only repairs a missing Mailbox item.
function republishUnchanged({ slug, existing, manifest, summary, caller }, ctx) {
  const item = readMessages({ dir: ctx.dir }).find((record) => record.kind === 'review' && !record.closedAt
    && record.review?.slug === slug && record.review?.pack === existing.pack && record.review?.version === existing.version);
  if (item) {
    if (existing.mailId === item.id) { ctx.out(`Unchanged: ${slug}/${existing.pack} v${existing.version} holds the same content. Nothing was published.`); return EXIT.ok; }
    try { ctx.deps.setMailId({ dir: ctx.dir, slug, pack: existing.pack, mailId: item.id }); }
    catch (error) { throw new ReviewCliError(`The pack ${slug}/${existing.pack} v${existing.version} is stored, but Herdr Boss did not link its Mailbox item: ${safeText(error?.message, 300)}. Run the same herdr-boss review publish command again.`); }
    ctx.out(`Repaired: linked the Mailbox item ${item.id} to ${slug}/${existing.pack} v${existing.version}. No new version.`);
    return EXIT.ok;
  }
  const record = postItem({ slug, pack: existing.pack, version: existing.version, title: manifest.title, text: `${summary}.`, caller }, ctx);
  ctx.out(`Repaired: posted the missing Mailbox item ${record.id} for ${slug}/${existing.pack} v${existing.version}. No new version.`);
  ctx.out(`Review: ${reviewUrl(slug, existing.pack, ctx.baseUrl)}`);
  return EXIT.ok;
}

function cloneValue(value) { return JSON.parse(JSON.stringify(value)); }

function fileReferences(value, known, found = new Set()) {
  if (typeof value === 'string') { if (known.has(value)) found.add(value); }
  else if (Array.isArray(value)) for (const entry of value) fileReferences(entry, known, found);
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) fileReferences(entry, known, found);
  return found;
}

function replaceFileReferences(value, renamed) {
  if (typeof value === 'string') return renamed.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => replaceFileReferences(entry, renamed));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceFileReferences(entry, renamed)]));
  return value;
}

// Copy open item specs and any files they use from one earlier result in the same planner session.
function carryItems(validation, previous, { dir }) {
  const manifest = validation.manifest;
  const present = new Set(manifest.sections.flatMap((section) => section.items.map((item) => item.id)));
  const sourceSections = new Map(previous.manifest.sections.map((section) => [section.id, section]));
  const specs = new Map(previous.manifest.sections.flatMap((section) => section.items.map((item) => [item.id, item])));
  const open = previous.items.filter((item) => item.state === 'open' || item.state === 'changed');
  const additions = open.filter((item) => !present.has(item.id));
  const sourceFiles = new Map(previous.files.map((file) => [file.path, file]));
  const targetFiles = new Map(validation.files.map((file) => [file.path, file]));
  const fileSources = {};
  const answers = {};
  let extraBytes = 0;

  for (const item of additions) {
    const sourceSection = sourceSections.get(item.section);
    if (!sourceSection) throw new ReviewCliError(`Herdr Boss cannot carry item ${item.id}; its section is missing.`);
    let section = manifest.sections.find((entry) => entry.id === sourceSection.id);
    if (!section) {
      if (manifest.sections.length >= DEFAULT_LIMITS.sections) throw new ReviewCliError(`The new pack would have more than ${DEFAULT_LIMITS.sections} sections after carrying open items.`);
      section = { id: sourceSection.id, title: sourceSection.title, ...(sourceSection.summary ? { summary: sourceSection.summary } : {}), items: [] };
      manifest.sections.push(section);
    }
    if (section.items.length >= DEFAULT_LIMITS.itemsPerSection) throw new ReviewCliError(`Section ${section.id} would have more than ${DEFAULT_LIMITS.itemsPerSection} items after carrying open items.`);

    const spec = cloneValue(specs.get(item.id));
    const renamed = new Map();
    for (const filePath of fileReferences(spec, new Set(sourceFiles.keys()))) {
      const source = sourceFiles.get(filePath);
      const target = targetFiles.get(filePath);
      if (target && target.sha256 === source.sha256) continue;
      let destination = filePath;
      if (target) {
        const key = crypto.createHash('sha256').update(`${previous.pack}\0${previous.version}\0${filePath}\0${source.sha256}`).digest('hex');
        destination = `carry/${previous.pack}/${key}`;
        const collision = targetFiles.get(destination);
        if (collision && collision.sha256 !== source.sha256) throw new ReviewCliError(`Herdr Boss cannot carry file ${filePath}; its carried path is already in use.`);
        renamed.set(filePath, destination);
      }
      if (!targetFiles.has(destination)) {
        const verified = getFile({ dir, slug: previous.slug, pack: previous.pack, version: previous.version, file: filePath });
        if (!verified) throw new ReviewCliError(`Herdr Boss cannot carry file ${filePath}; the submitted pack no longer has it.`);
        const copied = { path: destination, sha256: source.sha256, bytes: source.bytes, type: source.type };
        validation.files.push(copied);
        targetFiles.set(destination, copied);
        fileSources[destination] = { root: packDirectory(dir, previous.slug, previous.pack, previous.version), path: filePath };
        extraBytes += source.bytes;
      }
    }
    const copiedSpec = replaceFileReferences(spec, renamed);
    copiedSpec.hash = itemHash(copiedSpec, new Map([...targetFiles].map(([file, entry]) => [file, entry.sha256])));
    section.items.push(copiedSpec);
    present.add(item.id);
    if (item.answer && (item.answer.note || item.answer.pins?.length || item.skipped)) {
      answers[item.id] = {
        ...(item.skipped ? { decision: 'skip' } : {}),
        ...(item.answer.note ? { note: item.answer.note } : {}),
        ...(item.answer.pins?.length ? { pins: item.answer.pins } : {}),
      };
    }
  }

  const itemCount = manifest.sections.reduce((sum, section) => sum + section.items.length, 0);
  if (itemCount > DEFAULT_LIMITS.items) throw new ReviewCliError(`The new pack would have more than ${DEFAULT_LIMITS.items} items after carrying open items.`);
  if (validation.files.length > DEFAULT_LIMITS.files) throw new ReviewCliError(`The new pack would have more than ${DEFAULT_LIMITS.files} files after carrying open items.`);
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
  if (manifestBytes > DEFAULT_LIMITS.manifestBytes) throw new ReviewCliError(`The new pack manifest would be larger than ${DEFAULT_LIMITS.manifestBytes} bytes after carrying open items.`);
  const bytes = validation.files.reduce((sum, file) => sum + file.bytes, 0) + manifestBytes;
  if (bytes > DEFAULT_LIMITS.totalBytes) throw new ReviewCliError(`The new pack would be larger than ${DEFAULT_LIMITS.totalBytes} bytes after carrying open items.`);
  validation.totals.items = itemCount;
  validation.totals.sections = manifest.sections.length;
  validation.totals.bytes = bytes;
  return { count: additions.length, fileSources, answers };
}

function previousSubmittedPack(slug, session, dir, excludePack) {
  return listPacks({ dir, slug, state: 'done' }).map((entry) => getPack({ dir, slug, pack: entry.pack }))
    .filter((pack) => pack?.pack !== excludePack && pack?.state === 'submitted' && pack.manifest?.session === session)
    .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || '') || a.pack.localeCompare(b.pack))[0] ?? null;
}

// Validate, then publish or dry-run one pack folder. `imported` allows the page item type.
function publishFolder({ slug, folder, caller, note, dryRun, imported = false, round: wantedRound, carryOpen = false }, ctx) {
  const { out, err, dir, now, deps } = ctx;
  const validation = validatePack(folder, { allowPage: imported });
  printWarnings(validation, ctx);
  if (!validation.ok || !validation.manifest) {
    printErrors(validation, ctx);
    err(`The pack has ${plural(validation.errors.length, 'error')}. Nothing was published.`);
    return EXIT.invalid;
  }
  const { manifest, totals } = validation;
  let carried = { count: 0, fileSources: {}, answers: {} };
  let previous = null;
  if (carryOpen) {
    if (!caller.planner) throw new ReviewCliError('--carry-open needs an active planner session.');
    previous = previousSubmittedPack(slug, caller.session.id, dir, manifest.id);
    if (previous) carried = carryItems(validation, previous, { dir });
  }
  const summary = `${plural(totals.items, 'item')} in ${plural(totals.sections, 'section')}`;
  // These checks come before the write, so a refusal publishes nothing.
  // Only a planner pane tags a pack with a session. The tag decides where the result goes.
  if (!caller.planner && (manifest.session !== undefined || manifest.round !== undefined)) {
    throw new ReviewCliError('Only a pane with a planner session can publish a pack with session or round. Remove both fields from manifest.json.');
  }
  refuseSecret(manifest.title, 'pack title');
  if (note !== undefined) {
    if (!note.trim() || note.length > NOTE_MAX) throw new ReviewCliError(`The note must be 1 to ${NOTE_MAX} characters.`);
    refuseSecret(note, 'note');
  }
  if (dryRun) {
    out(`Dry run: ${slug}/${manifest.id} "${safeText(manifest.title)}" would be published as the next version. ${summary}, ${plural(validation.files.length + 1, 'file')}, ${totals.bytes} bytes.${carryOpen ? ` ${plural(carried.count, 'open item')} would be carried${previous ? ` from ${slug}/${previous.pack}` : ''}.` : ''} Nothing was written.`);
    return EXIT.ok;
  }
  const existing = getPack({ dir, slug, pack: manifest.id });
  // A planner publish fills session and round, so the compare leaves both out.
  const content = (value) => { const { session, round, ...rest } = value; return caller.planner ? rest : value; };
  if (existing && existing.state === 'open' && note === undefined && JSON.stringify(content(existing.manifest)) === JSON.stringify(content(manifest))) {
    return republishUnchanged({ slug, existing, manifest, summary, caller }, ctx);
  }
  // A planner pane publishes in the name of its session. The next round is stored after the publish succeeds.
  // The round counts per pack. A new pack takes the next round of the session. A republish of a pack of the same session keeps its
  // round. `--round N` sets another round.
  const keptRound = existing?.manifest?.session === caller.session?.id ? existing?.manifest?.round : undefined;
  const round = caller.planner ? wantedRound ?? keptRound ?? caller.session.round + 1 : null;
  if (caller.planner) Object.assign(manifest, { session: caller.session.id, round });
  let published;
  try {
    published = deps.publishVersion({ dir, now, slug, folder, publishedBy: caller.from, validation, fileSources: carried.fileSources });
  } catch (error) {
    if (!(error instanceof ReviewStoreError)) throw error;
    if (error.code === 'validation') {
      for (const problem of error.errors ?? []) err(`Error: ${safeText(problem.message, 500)}`);
      err('The pack is not valid. Nothing was published.');
      return EXIT.invalid;
    }
    const oldest = error.code === 'quota' && error.oldest?.length ? ` Delete a submitted pack first: ${error.oldest.map((entry) => `${entry.slug}/${entry.pack}`).join(', ')}.` : '';
    throw new ReviewCliError(`Herdr Boss did not publish the pack. ${error.message}${oldest}`);
  }
  for (const [item, patch] of Object.entries(carried.answers)) {
    try { deps.putAnswer({ dir, now, slug, pack: published.pack, item, patch: { rev: 0, ...patch } }); }
    catch (error) { err(`Warning: Herdr Boss published ${slug}/${published.pack} but did not copy the saved note or pins for item ${item}: ${safeText(error?.message, 200)}`); }
  }
  const paragraph = [`${summary}.`];
  const changes = changeText(published);
  if (changes) paragraph.push(changes);
  if (published.stale.length) paragraph.push(`${plural(published.stale.length, 'answer')} need a new decision.`);
  const text = [paragraph.join(' '), note?.trim()].filter(Boolean).join('\n\n');
  if (caller.planner && round > caller.session.round) {
    try { setRound({ dir, id: caller.session.id, round }); }
    catch (error) { err(`Warning: Herdr Boss did not store round ${round} of the planner session: ${safeText(error?.message, 200)}`); }
  }
  const record = postItem({ slug, pack: published.pack, version: published.version, title: manifest.title, text, caller }, ctx);
  out(`Published ${slug}/${published.pack} v${published.version}: ${summary}.${caller.planner ? ` Session ${caller.session.id}, round ${round}.` : ''}`);
  out(`Review: ${reviewUrl(slug, published.pack, ctx.baseUrl)}`);
  out(`Mailbox item ${record.id} asks the Owner to decide.`);
  if (carryOpen) out(`Carried ${plural(carried.count, 'open item')}${previous ? ` from ${slug}/${previous.pack}` : ''}.`);
  if (published.stale.length) out(`${plural(published.stale.length, 'answer')} need a new decision: ${published.stale.join(', ')}.`);
  return EXIT.ok;
}

// ---------- Commands ----------

function checkCommand(args, ctx) {
  const { positional } = parse(args, {}, USAGE.check);
  if (positional.length !== 1) throw new ReviewCliError(USAGE.check);
  const validation = validatePack(positional[0]);
  printWarnings(validation, ctx);
  if (!validation.ok || !validation.manifest) {
    printErrors(validation, ctx);
    ctx.err(`The pack has ${plural(validation.errors.length, 'error')}.`);
    return EXIT.invalid;
  }
  const { manifest, totals } = validation;
  ctx.out(`The pack ${manifest.id} is valid: ${plural(totals.sections, 'section')}, ${plural(totals.items, 'item')}, ${plural(validation.files.length + 1, 'file')}, ${totals.bytes} bytes.`);
  return EXIT.ok;
}

function publishCommand(args, ctx) {
  const { flags, positional } = parse(args, { values: ['--note', '--round'], switches: ['--dry-run', '--carry-open'] }, USAGE.publish);
  if (positional.length !== 2) throw new ReviewCliError(USAGE.publish);
  const slug = checkSlug(positional[0], USAGE.publish);
  const caller = verifyReviewCaller('review publish', slug, ctx, { planner: true });
  let round;
  if (flags['--round'] !== undefined) {
    if (!/^[1-9]\d{0,3}$/.test(flags['--round'])) throw new ReviewCliError(`The round must be a whole number from 1 to 9999. ${USAGE.publish}`);
    if (!caller.planner) throw new ReviewCliError('--round is only for a pane with a planner session.');
    round = Number(flags['--round']);
  }
  return publishFolder({ slug, folder: positional[1], caller, note: flags['--note'], dryRun: !!flags['--dry-run'], round, carryOpen: !!flags['--carry-open'] }, ctx);
}

function reopenCommand(args, ctx) {
  const { positional } = parse(args, {}, USAGE.reopen);
  if (positional.length !== 3) throw new ReviewCliError(USAGE.reopen);
  const [rawSlug, pack, item] = positional;
  const slug = checkSlug(rawSlug, USAGE.reopen);
  if (typeof pack !== 'string' || !SLUG.test(pack)) throw new ReviewCliError(`The pack ID must match [a-z0-9][a-z0-9-]* and have at most 64 characters. ${USAGE.reopen}`);
  if (typeof item !== 'string' || !SLUG.test(item)) throw new ReviewCliError(`The item ID must match [a-z0-9][a-z0-9-]* and have at most 64 characters. ${USAGE.reopen}`);
  const caller = verifyReviewCaller('review reopen', slug, ctx, { planner: true });
  ctx.deps.reopenItem({ dir: ctx.dir, now: ctx.now, slug, pack, item, ...(caller.session ? { session: caller.session.id } : {}) });
  ctx.out(`Reopened ${slug}/${pack} item ${item}.`);
  return EXIT.ok;
}

function importCommand(args, ctx) {
  const { flags, positional } = parse(args, { values: ['--id', '--title'], switches: ['--dry-run'] }, USAGE.import);
  if (positional.length !== 2) throw new ReviewCliError(USAGE.import);
  const slug = checkSlug(positional[0], USAGE.import);
  const caller = verifyReviewCaller('review import', slug, ctx);
  const built = buildImport({ source: positional[1], id: flags['--id'], title: flags['--title'] });
  try {
    ctx.out(`Import: ${plural(built.pages, 'page')}, ${plural(built.images, 'image')}.`);
    // Each text below comes from an HTML page or a file name, so it passes safeText() and stays short.
    const LIST_MAX = 100;
    if (built.external.length) {
      ctx.out('External URLs that the pages use. The frame blocks them and Herdr Boss did not fetch them:');
      for (const url of built.external.slice(0, LIST_MAX)) ctx.out(`  ${safeText(url)}`);
      if (built.external.length > LIST_MAX) ctx.out(`  and ${built.external.length - LIST_MAX} more`);
    }
    if (built.skipped.length) {
      ctx.out('Not imported:');
      for (const entry of built.skipped.slice(0, LIST_MAX)) ctx.out(`  ${safeText(entry.file)}: ${safeText(entry.reason)}`);
      if (built.skipped.length > LIST_MAX) ctx.out(`  and ${built.skipped.length - LIST_MAX} more`);
    }
    return publishFolder({ slug, folder: built.folder, caller, dryRun: !!flags['--dry-run'], imported: true }, ctx);
  } finally { built.cleanup(); }
}

export { resultMarkdown };

function resultCommand(args, ctx) {
  const { flags, positional } = parse(args, { values: ['--version', '--format'], switches: ['--json'] }, USAGE.result);
  if (flags['--json'] && flags['--format'] !== undefined) throw new ReviewCliError(`Use --format or --json, not both. ${USAGE.result}`);
  const format = flags['--json'] ? 'json' : flags['--format'] ?? 'md';
  if (!['json', 'md'].includes(format)) throw new ReviewCliError(`The format must be json or md. ${USAGE.result}`);
  let version;
  if (flags['--version'] !== undefined) {
    if (!/^[1-9]\d{0,8}$/.test(flags['--version'])) throw new ReviewCliError(`The version must be a whole number of 1 or more. ${USAGE.result}`);
    version = Number(flags['--version']);
  }
  const { slug, pack } = resolvePack(positional, USAGE.result, { env: ctx.env, control: ctx.control() });
  verifyReviewCaller('review result', slug, ctx);
  if (!getPack({ dir: ctx.dir, slug, pack })) { ctx.err(`No pack ${slug}/${pack} exists.`); return EXIT.missing; }
  const record = getResultRecord({ dir: ctx.dir, slug, pack, version });
  if (!record) {
    ctx.err(version === undefined ? `No result for ${slug}/${pack} yet. The Owner has not submitted the review.` : `No result for ${slug}/${pack} version ${version}. The Owner has not submitted that version.`);
    return EXIT.missing;
  }
  ctx.out(format === 'json' ? JSON.stringify(record.result, null, 2) : record.markdown.trimEnd());
  return EXIT.ok;
}

function deleteCommand(args, ctx) {
  const { positional } = parse(args, {}, USAGE.delete);
  const { slug, pack } = resolvePack(positional, USAGE.delete, { env: ctx.env, control: ctx.control() });
  verifyReviewCaller('review delete', slug, ctx);
  if (!getPack({ dir: ctx.dir, slug, pack })) { ctx.err(`No pack ${slug}/${pack} exists.`); return EXIT.missing; }
  deletePack({ dir: ctx.dir, slug, pack });
  const { closed } = closeReviewItems({ slug, pack }, { dir: ctx.dir, now: ctx.now });
  ctx.out(`Deleted ${slug}/${pack}. Closed ${plural(closed, 'Mailbox item')}.`);
  return EXIT.ok;
}

function listCommand(args, ctx) {
  const { flags, positional } = parse(args, { values: ['--state'], switches: ['--json'] }, USAGE.list);
  if (positional.length > 1) throw new ReviewCliError(USAGE.list);
  const state = flags['--state'] ?? 'open';
  if (!STATES.includes(state)) throw new ReviewCliError(`The state must be one of ${STATES.join(', ')}. ${USAGE.list}`);
  let slug = positional[0] === undefined ? undefined : checkSlug(positional[0], USAGE.list);
  // The scope is the same as for publish. An orch pane lists its own project. The Boss and a plain terminal list every project.
  if (!isPlainTerminal(ctx.env)) {
    const caller = verifyMessageCaller(ctx.env, ctx.herdr, 'review list');
    if (caller.role === 'orch') {
      const own = projectOf(ctx.control(), caller.workspaceId);
      if (!own) throw new ReviewCliError(`No project uses workspace ${caller.workspaceId}. Publish the project status, then wait for the next Herdr Boss tick.`);
      if (slug !== undefined && slug !== own) throw new ReviewCliError(`This pane belongs to project ${own}. It can run herdr-boss review list only for the slug ${own}, not for ${slug}.`);
      slug = own;
    }
  }
  const packs = listPacks({ dir: ctx.dir, state, slug });
  if (flags['--json']) { ctx.out(JSON.stringify(packs, null, 2)); return EXIT.ok; }
  if (!packs.length) { ctx.out('No review packs.'); return EXIT.ok; }
  for (const entry of packs) {
    const answered = entry.counts.items - entry.counts.open;
    const status = entry.state === 'submitted' ? `submitted ${entry.verdict ? verdictLabel(entry.verdict) : ''}`.trim() : entry.state;
    const changed = entry.counts.changed ? `, ${entry.counts.changed} changed` : '';
    ctx.out(`${entry.slug}/${entry.pack}  v${entry.version}  ${status}  ${answered} of ${entry.counts.items} answered${changed}  ${safeText(entry.title)}`);
  }
  return EXIT.ok;
}

// Run one review command. Returns the exit code.
export function reviewCommand(args, { env = process.env, herdr, dir = DATA_DIR, now = Date.now(), baseUrl = null, deps = {}, out = (line) => console.log(line), err = (line) => console.error(line) } = {}) {
  const [sub, ...rest] = args;
  let control = null;
  const ctx = { env, herdr, dir, now, baseUrl, out, err, deps: { publishVersion, postReview, putAnswer, setMailId, reopenItem, ...deps }, control: () => (control ??= readControl(dir)) };
  const commands = { check: checkCommand, publish: publishCommand, import: importCommand, result: resultCommand, delete: deleteCommand, reopen: reopenCommand, list: listCommand };
  try {
    if (!Object.hasOwn(commands, sub)) throw new ReviewCliError(USAGE_ALL);
    return commands[sub](rest, ctx);
  } catch (error) {
    // A file system error keeps its code for the sandbox message of the caller.
    if (error instanceof ReviewCliError) { err(error.message); return error.exitCode; }
    if (error?.code && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code) && !(error instanceof ReviewStoreError)) throw error;
    err(error instanceof Error ? error.message : String(error));
    return EXIT.refused;
  }
}
