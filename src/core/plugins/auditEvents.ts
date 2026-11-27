// The kinds of plugin audit record (Phase 2 gate), node-free so the renderer's Plugin Inspector names each in words.
export const AUDIT_EVENTS = [
  'installed',
  'updated',
  'enabled',
  'disabled',
  'removed',
  'configured',
  'change-refused',
  'started',
  'exited',
  'stopped',
  'failed',
  'call',
  'call-refused',
  'panel-opened',
  'bridge-refused',
  'attach-refused'
] as const
