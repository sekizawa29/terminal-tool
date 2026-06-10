// Foreground process names that identify an AI coding agent running in a
// terminal. Shared by the window glow, the sidebar status dot, and the
// offscreen-attention detection so the heuristic stays consistent.
export const AGENT_PROCESSES = new Set([
  'claude', 'codex', 'aider', 'cursor', 'copilot',
  'cline', 'roo',
]);

export function isAgentProcess(process: string): boolean {
  return AGENT_PROCESSES.has(process);
}
