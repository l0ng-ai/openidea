/** The session id the window's debug-start action reports back to the MCP caller. */
let started: number | null = null;

export function setMcpDebugSession(id: number) {
  started = id;
}

export function takeMcpDebugSession(): number | null {
  const id = started;
  started = null;
  return id;
}
