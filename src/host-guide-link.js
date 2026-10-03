// The link from a failure message of the host tool to the "Add a host" page of the dashboard.
// The page is /fleet/add-host. The dashboard base address is not known here, so the hint names the page path.
export const HOST_GUIDE_PATH = '/fleet/add-host';

// A failure that the host guide can help with: the host does not answer, SSH or Docker does not start, or the host has no record.
const HOST_FAILURE = /host is unreachable|host-unreachable|Docker transport failed|Docker could not start|ssh could not start|not in the private connection store|not in the registry|no Docker context|Docker context to the private host record|no SSH connection record/i;
const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

// The line to add after a failure message, or an empty text when the failure has nothing to do with the host.
export function hostGuideHint(message, host) {
  if (!HOST_FAILURE.test(String(message ?? ''))) return '';
  const query = typeof host === 'string' && HOST_NAME.test(host) ? `?host=${host}` : '';
  return `Host setup guide: open ${HOST_GUIDE_PATH}${query} in the dashboard (Fleet, Add a host) to check the host step by step.`;
}
