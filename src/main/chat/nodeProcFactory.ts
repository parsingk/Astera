// A line process as the app's own child — the ProcFactory used when there is no Host (dev mode, or a
// Host that is down). It dies with the app, and the session built on it says so (chat-sessions design
// §6.5). Lines are split by the same splitter the Host uses. The body lives in core/sessions so the
// Host process can use it too.
export { nodeProcFactory } from '../../core/sessions/nodeProcFactory'
