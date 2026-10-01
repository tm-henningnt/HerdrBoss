// The synchronous launch paths run this helper in a bounded process. Use the browser pool for ownership and leases.
import { pathToFileURL } from 'node:url';
import { browserStatus, listBrowserSessions, requestBrowser } from './browser-pool.js';

export async function resolveCodexBrowser(project, { listSessions = listBrowserSessions, status = browserStatus, request = requestBrowser, launch = true } = {}) {
  const session = listSessions()[project];
  if (!session) return null;
  let browser = await status(session);
  if ((!browser.profileVerified || !browser.responsive) && launch) browser = await request(project);
  return browser.profileVerified && browser.responsive ? { port: browser.port } : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let browser = null;
  try { browser = await resolveCodexBrowser(process.argv[2], { launch: !process.argv.includes('--no-launch') }); }
  catch { /* The launcher prints one fixed fallback line. Never pass raw errors to it. */ }
  console.log(JSON.stringify(browser));
}
