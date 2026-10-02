// publish --sync: rewrite the card states of a status from the computed states before the status is installed.
// docs/board.md holds the rules. A card without a fact keeps its state.
import { applyBoardFacts } from './board-facts.js';
import { overlayTasks } from './task-state.js';

// The status of a card for a computed state. A stuck card is doing.
const statusOf = (computedState) => (computedState === 'stuck' ? 'doing' : computedState);

// Change data.tasks in place. facts is { commits, issues } as BoardFactsCache.get() gives it.
// Returns the changed cards as [{ id, from, to, commit? }]. A commit fact includes the short id and subject.
export function syncStatuses(data, { workers = [], facts = {}, now = Date.now() } = {}) {
  if (!Array.isArray(data?.tasks)) return [];
  const computed = applyBoardFacts(overlayTasks(data.tasks, workers), workers, facts, { now });
  const changed = [];
  data.tasks.forEach((task, index) => {
    const result = computed[index];
    if (!task || typeof task !== 'object' || result?.diverges !== true) return;
    const to = statusOf(result.computedState);
    const from = task.status || 'todo';
    if (to === from) return;
    task.status = to;
    const match = result.source?.kind === 'commit'
      ? facts.commits?.find((commit) => commit.short === result.source.ref)
      : null;
    changed.push({
      id: String(task.id), from, to,
      ...(match ? { commit: { short: match.short, subject: match.subject } } : {}),
    });
  });
  return changed;
}
