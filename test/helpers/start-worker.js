import { startWorker as startWorkerImpl } from '../../src/kit/workers.js';

const ampleFreeSpace = () => ({ bsize: 1, bavail: 500 * 1024 ** 3 });

// Keep worker-start fixtures independent of the host disk. Disk tests pass their own reader.
export function startWorker(name, options, deps = {}) {
  return startWorkerImpl(name, options, {
    freeSpaceReader: ampleFreeSpace,
    ...deps,
  });
}
