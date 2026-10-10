const REQUIRED_HEADINGS = Object.freeze(['What', 'Why', 'Cost', 'Recommendation', 'Choices']);

export function proposalSections(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[index]);
    if (match) found.push({ title: match[1].trim(), start: index, end: lines.length });
  }
  for (let index = 0; index < found.length - 1; index += 1) found[index].end = found[index + 1].start;
  return { lines, found };
}

export function requiredProposalSections(text, titles) {
  const { lines, found } = proposalSections(text);
  const errors = [];
  const values = {};
  for (const title of titles) {
    const matches = found.filter((section) => section.title === title);
    if (!matches.length) errors.push(`Missing heading: ${title}`);
    else if (matches.length > 1) errors.push(`Duplicate heading: ${title}`);
    if (matches.length === 1) {
      values[title] = lines.slice(matches[0].start + 1, matches[0].end).join('\n').trim();
      if (!values[title]) errors.push(`Missing content: ${title}`);
    }
  }
  return { values, errors };
}

export function validateProposalFile(text) {
  const { lines, found } = proposalSections(text);
  const errors = [];
  for (const title of REQUIRED_HEADINGS) {
    const count = found.filter((section) => section.title === title).length;
    if (count === 0) errors.push(`Missing heading: ${title}`);
    else if (count > 1) errors.push(`Duplicate heading: ${title}`);
  }

  for (const title of ['What', 'Why', 'Recommendation']) {
    const section = found.find((item) => item.title === title);
    if (section && !lines.slice(section.start + 1, section.end).join('\n').trim()) {
      errors.push(`Missing content: ${title}`);
    }
  }

  const cost = found.find((section) => section.title === 'Cost');
  if (cost) {
    const body = lines.slice(cost.start + 1, cost.end).join('\n');
    if (!/^Lane:\s*\S.*$/im.test(body)) errors.push('Missing cost field: Lane');
    if (!/^Size:\s*\S.*$/im.test(body)) errors.push('Missing cost field: Size');
  }

  const choices = found.find((section) => section.title === 'Choices');
  const items = choices
    ? lines.slice(choices.start + 1, choices.end)
      .map((line) => /^\s*[-*+]\s+(.+?)\s*$/.exec(line)?.[1])
      .filter((item) => item !== undefined)
    : [];
  if (!items.includes('Accept')) errors.push('Missing choice: Accept');
  if (!items.includes('Deny')) errors.push('Missing choice: Deny');
  if (items.length !== 2 || items[0] !== 'Accept' || items[1] !== 'Deny') {
    errors.push('Choices must be exactly Accept and Deny');
  }
  return errors;
}
