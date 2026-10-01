export const ATTACHMENT_LIMIT = 6;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_ATTACHMENT_TYPES = Object.freeze([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
]);

const TYPE_SET = new Set(SUPPORTED_ATTACHMENT_TYPES);
const ATTACHMENT_ID = /^att_[0-9a-f]{32}$/;
const PREVIEW_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function attachmentFileError(file) {
  if (Number(file?.size) > MAX_ATTACHMENT_BYTES) return 'Each picture must be 10 MB or smaller.';
  const type = String(file?.type || '').toLowerCase().split(';')[0].trim();
  if (!TYPE_SET.has(type)) return 'Use a JPEG, PNG, WebP, GIF, HEIC or HEIF picture.';
  return '';
}

export function attachmentStripState(items) {
  const list = Array.isArray(items) ? items : [];
  const statuses = list.map((item) => ['uploading', 'ready', 'failed'].includes(item?.status) ? item.status : 'failed');
  const ids = list.filter((item, index) => statuses[index] === 'ready' && ATTACHMENT_ID.test(item.id || '')).map((item) => item.id);
  return {
    count: list.length,
    canAdd: list.length < ATTACHMENT_LIMIT,
    uploading: statuses.filter((status) => status === 'uploading').length,
    ready: ids.length,
    failed: statuses.filter((status) => status === 'failed').length,
    ids,
  };
}

// Keep the file input in the DOM, but hidden. Do not set capture so mobile browsers can offer the photo library and camera.
export function attachmentPickerHtml(context, icon, esc, { disabled = false } = {}) {
  const key = esc(context);
  const off = disabled ? ' disabled' : '';
  return `<span class="attachment-picker"><button type="button" class="app-icon-button attachment-open" data-attachment-open="${key}" aria-label="Attach a picture" title="Attach a picture"${off}>${icon('attach')}</button><input type="file" accept="image/*" multiple hidden data-attachment-input="${key}"${off}></span>`;
}

export function attachmentStripHtml(context, items, esc, notice = '') {
  const key = esc(context);
  const list = Array.isArray(items) ? items : [];
  const state = attachmentStripState(list);
  const chips = list.map((item, index) => {
    const itemKey = esc(item.key || String(index));
    const name = esc(item.name || 'Picture');
    const removeKey = esc(`${context}:${item.key || index}`);
    const image = item.previewUrl && PREVIEW_TYPES.has(item.type)
      ? `<img src="${esc(item.previewUrl)}" alt="" width="64" height="52">`
      : `<span class="attachment-file-icon" aria-hidden="true">IMG</span>`;
    const status = item.status === 'uploading' ? 'Uploading…'
      : item.status === 'failed' ? `Failed: ${item.error || 'Upload failed.'}` : 'Ready';
    return `<li class="attachment-chip${item.status === 'failed' ? ' failed' : ''}" data-key="attachment:${itemKey}"><span class="attachment-preview">${image}</span><span class="attachment-chip-name" title="${name}">${name}</span><span class="attachment-chip-state" role="status">${esc(status)}</span><button type="button" class="attachment-remove" data-attachment-remove="${removeKey}" aria-label="Remove ${name}" title="Remove ${name}">×</button></li>`;
  }).join('');
  const message = notice ? `<p class="attachment-notice" role="status">${esc(notice)}</p>` : '';
  const hidden = !list.length && !notice ? ' hidden' : '';
  return `<div class="attachment-strip" data-key="attachment-strip:${key}" data-attachment-strip="${key}" aria-label="Attached pictures"${hidden}>${message}${state.count ? `<ul>${chips}</ul>` : ''}</div>`;
}
