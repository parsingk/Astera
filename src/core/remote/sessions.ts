// What a controller and a Runtime agree on for a remote session's commands (remote runtime design Phase 9). Shared by
// the Host's checks (host/remoteSessions.ts) and the app's input batching (renderer lib/remoteSessions.ts).
// node: import 없음 — 렌더러가 import한다.

/** The most one `sessions-input` carries: a paste, never a file. */
export const SESSION_INPUT_MAX = 64 * 1024
/** The longest message a declined approval carries back to the CLI. */
export const ANSWER_MESSAGE_MAX = 4096
