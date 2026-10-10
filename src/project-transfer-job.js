// Run the synchronous clone, kit install, and Herdr startup outside the HTTP thread.
import { parentPort, workerData } from 'node:worker_threads';
import { createProjectTransfer } from './project-transfer.js';

const transfer = createProjectTransfer({ ...workerData.options, role: 'target',
  settings: () => workerData.settings, kitRevision: () => workerData.revision });
parentPort.postMessage(await transfer.handle(workerData.body));
