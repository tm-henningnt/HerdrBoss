const STORAGE_KEY = 'herdrBoss.dismissedInfoAlerts';
let memoryDismissals = {};

function browserStorage() {
  try { return globalThis.localStorage; }
  catch { return null; }
}

function dismissedRows(storage) {
  const rows = { ...memoryDismissals };
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(rows, parsed);
  } catch { /* Storage is optional. */ }
  return rows;
}

function timeValue(value) {
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function filterDismissedInfoAlerts(alerts, storage = browserStorage()) {
  const dismissed = dismissedRows(storage);
  return (alerts || []).filter((alert) => {
    if (alert.severity !== 'info' || !alert.key) return true;
    const dismissedAt = timeValue(dismissed[alert.key]);
    if (dismissedAt == null) return true;
    const firstAt = timeValue(alert.firstAt);
    return firstAt == null || firstAt > dismissedAt;
  });
}

export function dismissInformationalAlert(alert, storage = browserStorage(), now = Date.now()) {
  if (alert?.severity !== 'info' || typeof alert.key !== 'string' || !alert.key || !Number.isFinite(now)) return false;
  memoryDismissals[alert.key] = now;
  const dismissed = dismissedRows(storage);
  dismissed[alert.key] = now;
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(dismissed)); }
  catch { /* The in-memory dismissal still hides the row until this page closes. */ }
  return true;
}
