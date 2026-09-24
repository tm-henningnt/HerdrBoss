const COMMANDS = new Map([
  ['create', ['issue', 'create']],
  ['comment', ['issue', 'comment']],
  ['edit', ['issue', 'edit']],
]);

export function buildGhArgs(command, args) {
  const prefix = COMMANDS.get(command);
  if (!prefix) throw new Error(`unsupported safe GitHub command: ${String(command)}.`);
  if (args.some((arg) => arg === '--body' || arg.startsWith('--body='))) throw new Error('inline --body is not allowed; use --body-file.');
  const indices = args.flatMap((arg, index) => arg === '--body-file' ? [index] : []);
  if (indices.length !== 1) throw new Error('exactly one --body-file argument is required.');
  const bodyIndex = indices[0];
  const bodyPath = args[bodyIndex + 1];
  if (!bodyPath || bodyPath.startsWith('--')) throw new Error('--body-file needs a file path.');
  if ((command === 'comment' || command === 'edit') && !/^\d+$/.test(args[0] ?? '')) throw new Error(`${command} needs a numeric issue number first.`);
  if (bodyIndex === 0 && command !== 'create') throw new Error(`${command} needs an issue number before --body-file.`);
  return [...prefix, ...args];
}
