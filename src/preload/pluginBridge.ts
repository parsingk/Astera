// The bridge a plugin panel guest gets (ADR-008), the only preload main lets one attach with. It runs sandboxed, exposes
// one object on one channel, and carries no identity of its own: main reads which plugin a call is from by the guest
// that sent it. Phase 2 answers `context` only (core/plugins/panelGuest.ts BRIDGE_METHODS).
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('astera', {
  context: () => ipcRenderer.invoke('plugin-ui.call', 'context', null)
})
