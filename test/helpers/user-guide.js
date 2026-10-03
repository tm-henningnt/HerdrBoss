import fs from 'node:fs';

// The user documentation is split into the guide index, the guide chapters, and the Reference pages.
// A test that checks a documented sentence reads all of them as one text.
const DOCS = new URL('../../docs/', import.meta.url);

function markdownFiles(dir) {
  const folder = new URL(dir, DOCS);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => name.endsWith('.md')).sort().map((name) => new URL(dir + name, DOCS));
}

export function readUserGuide() {
  const files = [new URL('user-guide.md', DOCS), ...markdownFiles('reference/'), ...markdownFiles('guide/')];
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}
