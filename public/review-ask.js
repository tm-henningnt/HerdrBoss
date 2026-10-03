// The questions that the Owner can answer for one item. The store, the validator, and the viewer share this rule.
// An agent-verified item needs accept and deny, so that the Owner can confirm or reject the evidence.
// The rule applies to an item with no choice, rating, or live question. It also covers packs stored with ask `["note"]`.
const OTHER_DECISIONS = ['choice', 'rating', 'live'];

export function effectiveAsk(item) {
  const ask = Array.isArray(item?.ask) ? [...item.ask] : [];
  if (item?.verifiedBy !== 'agent-verified' || ask.some((name) => OTHER_DECISIONS.includes(name))) return ask;
  return ['accept', 'deny', ...ask.filter((name) => name !== 'accept' && name !== 'deny')];
}

// An item with no question except a note is information. The Owner cannot decide it, so it never counts as open.
export const isInfoOnly = (item) => effectiveAsk(item).every((name) => name === 'note');
