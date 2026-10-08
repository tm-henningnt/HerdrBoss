export function deriveTickReadings({ herdrRead, machineRead, processRead, lastHerdr }) {
  const currentHerdrSnapshot = herdrRead.ok;
  const currentPaneList = currentHerdrSnapshot && Array.isArray(herdrRead.value?.panes);

  return {
    herdr: currentHerdrSnapshot
      ? currentPaneList ? herdrRead.value : null
      : lastHerdr || null,
    currentHerdrSnapshot,
    currentPaneList,
    machine: machineRead.ok ? machineRead.value : null,
    procs: processRead.ok ? processRead.value : new Map(),
    processesKnown: processRead.ok,
  };
}
