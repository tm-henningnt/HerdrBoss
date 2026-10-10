// Keep page project filters consistent. A future multi-select can add more options here.
export function filterProjectVisibility(projects, { showParked = false } = {}) {
  const rows = Array.isArray(projects) ? projects : [];
  return rows.filter((project) => {
    const parked = project?.state === 'parked' || project?.state === 'archived';
    const share = Number.isFinite(project?.share) ? project.share : 0;
    return showParked || !parked || share > 0;
  });
}
