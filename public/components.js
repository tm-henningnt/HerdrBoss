export function listRowHtml(cells, escapeText) {
  if (!Array.isArray(cells) || typeof escapeText !== 'function') throw new TypeError('A row needs cells and a text escaper.');
  const rendered = cells.map((cell) => {
    const className = cell.className ? ` class="${escapeText(cell.className)}"` : '';
    const content = typeof cell.render === 'function' ? cell.render(escapeText) : escapeText(cell.text ?? '');
    return `<td${className} data-label="${escapeText(cell.label)}">${content}</td>`;
  }).join('');
  return `<tr>${rendered}</tr>`;
}

export function statusChipHtml({ state, label }, escapeText) {
  if (typeof escapeText !== 'function') throw new TypeError('A status chip needs a text escaper.');
  return `<span class="status-inline"><span class="st ${escapeText(state)}"></span>${escapeText(label)}</span>`;
}
