import fs from 'node:fs';
import path from 'node:path';
import { ProjectTypeValidationError, validateProjectTypeCatalog, validateProjectTypeFolder } from './project-type.js';

export const PROJECT_TYPE_USAGE = 'Usage: project type check FOLDER';

export function projectTypeCommand(args, { log = console.log, error = console.error } = {}) {
  if (args.length !== 2 || args[0] !== 'check' || !args[1] || args[1].startsWith('--')) throw new Error(PROJECT_TYPE_USAGE);
  const folder = path.resolve(args[1]);
  try {
    if (fs.existsSync(path.join(folder, 'manifest.json'))) {
      const { manifest } = validateProjectTypeFolder(folder);
      log(`Project type ${manifest.id} ${manifest.version} is valid.`);
    } else {
      const manifests = validateProjectTypeCatalog(folder);
      log(`Project type catalog is valid (${manifests.length} types).`);
    }
    return 0;
  } catch (validationError) {
    if (validationError instanceof ProjectTypeValidationError) {
      for (const issue of validationError.issues) error(`invalid: ${issue}`);
      return 1;
    }
    throw validationError;
  }
}
