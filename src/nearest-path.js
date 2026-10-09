import fs from 'node:fs';
import path from 'node:path';

// A volume path that does not exist yet reads the free space of its nearest existing parent folder.
// This module imports nothing from Herdr Boss, so any module can use it without an import cycle.
export function nearestExistingPath(file, { exists = fs.existsSync } = {}) {
  let current = path.resolve(file);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}
