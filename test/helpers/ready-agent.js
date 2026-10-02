// Fake agent-get response for worker fixtures that do not test readiness transitions.
export function readyAgent() {
  return { agent: { agent_status: 'idle', interactive_ready: true } };
}
