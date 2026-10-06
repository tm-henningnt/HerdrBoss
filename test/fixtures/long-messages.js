// Invented Markdown messages with the shapes that broke on a phone: wide tables, code blocks, long lists, headings, long unbroken strings, status items.
const LONG_PATH = '/Users/example/Projects/Sample/.herdr-wt/Sample/worker-one/src/very/deep/folder/structure/with/many/segments/report-final-v2.json';
const LONG_TOKEN = 'tok_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // herdr-boss: allow-test-token
const LONG_URL = 'https://example.com/a/very/long/path/that/keeps/going/and/going/with/query?alpha=1&beta=2&gamma=3&delta=4&epsilon=5&zeta=6&eta=7&theta=8';

const table = (cols, rows) => [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

export const LONG_MESSAGES = [
  `# Status report for the sample project\n\n## Done\n\n${table(['Task', 'Branch', 'Worker', 'Tests passed', 'Tests failed', 'Duration', 'Merged at', 'Notes'], [
    ['MF1', 'mf1-markdown', 'claude-one', '312', '0', '14 min', '2026-10-03 10:12', 'Tables scroll'],
    ['CP1', 'cp1-copy', 'claude-two', '298', '2', '22 min', '2026-10-03 11:40', 'Copy buttons for code'],
    ['DOC9', 'doc9-help', 'codex-three', '120', '0', '6 min', '2026-10-03 12:01', 'Help panel text'],
  ])}\n\n## Next\n\n- Review the diff\n- Merge in the integration worktree\n- Restart the service`,
  `## Files\n\nThe report is at \`${LONG_PATH}\` and the log is at \`${LONG_PATH}.log\`.\n\nA token looks like ${LONG_TOKEN} in plain text.\n\nOpen ${LONG_URL} to see it.`,
  `### Commands\n\n\`\`\`sh\ncd /Users/example/Projects/Sample && herdr-boss suite --wait 3600 -- npm test --test-concurrency=2 --test-reporter=spec --test-name-pattern="markdown renderer handles long unbroken input"\n\`\`\`\n\nThen run:\n\n\`\`\`json\n{"access":{"tokenFile":"${LONG_PATH}","port":4477,"host":"127.0.0.1","allowedOrigins":["http://127.0.0.1:4477","http://localhost:4477"]}}\n\`\`\``,
  `# Plan\n\n${Array.from({ length: 14 }, (_, i) => `${i + 1}. Step ${i + 1}: check \`src/module-${i}/handler-with-a-long-name-${i}.js\` and report the result to the orchestrator\n   - Sub item with detail about step ${i + 1}\n     - Third level item with a long sentence that wraps over several lines on a narrow screen`).join('\n')}`,
  `#### Heading four\n\n##### Heading five\n\n###### Heading six\n\nParagraph one.\n\n\n\nParagraph two after blank lines.\n\n---\n\n> A quote with a long line that goes on and on to see how the border and the padding behave on a narrow phone screen.\n\nLast paragraph.`,
  `## Status items\n\n- [x] Fixture written\n- [x] Renderer changed with \`overflow-wrap\` on every block that holds long text\n- [ ] Phone screenshots at 393 and 360\n- [ ] Owner check`,
  `## Matrix\n\n${table(['Name', 'Value'], [['alpha', '1'], ['beta', '22'], ['gamma', '333']])}\n\n${table(['Path', 'Size', 'Modified', 'Owner', 'Mode', 'Hash', 'Type', 'Tags', 'Link'], [
    [`\`${LONG_PATH}\``, '12 KB', '2026-10-03', 'example', '0644', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'json', 'a,b,c,d,e,f', LONG_URL],
    ['`src/a.js`', '1 KB', '2026-10-02', 'example', '0644', 'abc', 'js', '', ''],
  ])}`,
  `Inline \`code that is quite long and must wrap on a phone: ${LONG_PATH}\` inside a sentence, with **bold text**, *italic text*, ~~struck~~ and [a link](${LONG_URL} "title") in the same paragraph. ${'word '.repeat(40)}`,
  `\`\`\`\n${Array.from({ length: 30 }, (_, i) => `line ${String(i + 1).padStart(2, '0')}  ${'abcdefghij'.repeat(i % 7 + 3)}`).join('\n')}\n\`\`\``,
  `## Config\n\n\`\`\`yaml\nprojects:\n  sample:\n    path: ${LONG_PATH}\n    workers: [claude, codex, opencode, pi]\n    limits: {cpu: 80, memory: 85, swap: 40, disk: 90, network: 100}\n\`\`\`\n\nChange it, then restart.\n\n\`\`\`sh\nlaunchctl kickstart -k gui/$(id -u)/example.herdr-boss\n\`\`\``,
  `- Top item with \`${LONG_PATH}\`\n  - Child with ${LONG_TOKEN}\n    - Grandchild with ${LONG_URL}\n      - Great-grandchild with a long sentence that wraps over several lines on a narrow screen to show the indent\n        - Fifth level item`,
  `${table(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'], [['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']])}`,
  `## Mixed\n\nText before.\n\n- one\n- two\n\n\`\`\`js\nconst veryLongVariableName = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree, argumentNumberFour);\n\`\`\`\n\n1. first\n2. second\n\n${table(['K', 'V'], [['x', 'y']])}\n\nText after.`,
  `${'Supercalifragilisticexpialidocious'.repeat(8)}\n\n${LONG_TOKEN}${LONG_TOKEN}`,
  `# Heading one that is long enough to wrap over two lines on a phone\n\n## Heading two that is also long enough to wrap over more than one line\n\n### Heading three\n\nShort text.`,
];
