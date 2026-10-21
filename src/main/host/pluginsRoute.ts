// Settings › Plugins' way to the Host (plugin runtime design P5, slice 2d): the Host's own `plugins-*` commands, sent
// over the app's `orch-call` as the app, one method a command the tab uses, so the renderer names no other command. The
// Host checks everything; this only says what it answered, or why nothing came back.
import type { PluginsApi, PluginsCallAnswer } from '../../core/types'
import { DEFAULT_CHECK_TIMEOUT_MS } from '../../core/orchestration/types'
import { TIMEOUT_HEADROOM_MS } from '../../core/publicContract'
import { NO_HOST_CONNECTION, isHostDeadline } from './worktreeRoute'

/** How long the app waits for a change (install, enable, disable, remove, configure): the CLI's own deadline for
 *  them. A large folder's copy, a stop that waits for a plugin's deactivate, and a folder Windows will not let go of
 *  for a while all run past the app's usual one. */
export const PLUGIN_CHANGE_DEADLINE_MS = DEFAULT_CHECK_TIMEOUT_MS + TIMEOUT_HEADROOM_MS

type Call = (m: { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }) => Promise<{ status: number; body: unknown }>

const CODES: Record<number, string> = { 400: 'INVALID_ARGUMENTS', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 501: 'NOT_SUPPORTED' }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One Host command sent as the app, answered as the tab reads it: the body on a 200, else a code and the Host's
 *  sentence. Settings › Extensions sends its commands the same way (extensionsRoute.ts). */
export function hostSender(d: { call: Call }): (cmd: string, args: Record<string, unknown>, change?: boolean) => Promise<PluginsCallAnswer> {
  return async (cmd, args, change = false) => {
    let r: { status: number; body: unknown }
    try {
      r = await d.call({ cmd, args, sessionId: '', ...(change ? { timeoutMs: PLUGIN_CHANGE_DEADLINE_MS } : {}) })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Nothing was sent; the Host's deadline passed; or the connection went with the call out, and the change may
      // have been made.
      return { ok: false, code: message === NO_HOST_CONNECTION ? 'HOST_NOT_RUNNING' : isHostDeadline(message) ? 'TIMEOUT' : 'HOST_LOST', message }
    }
    const body = isObject(r.body) ? r.body : {}
    if (r.status === 200) return { ok: true, body }
    return {
      ok: false,
      code: typeof body.code === 'string' ? body.code : (CODES[r.status] ?? 'FAILED'),
      message: typeof body.error === 'string' ? body.error : `the Host answered ${r.status}`,
      // What went wrong in a few words, when the Host gives it beside its sentence (2e-2 final review M1).
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {})
    }
  }
}

export function createPluginsRoute(d: { call: Call }): PluginsApi {
  const send = hostSender(d)
  return {
    list: () => send('plugins-list', {}),
    // An npm package's inspect downloads it, so it waits as a change does (plugins 2e).
    inspect: (source) => send('plugins-inspect', { ...source }, 'npm' in source),
    install: (a) => send('plugins-install', { ...a }, true),
    setEnabled: (id, enabled) => send(enabled ? 'plugins-enable' : 'plugins-disable', { id }, true),
    remove: (id) => send('plugins-remove', { id }, true),
    logs: (id, lines) => send('plugins-logs', { id, lines }),
    settings: (id) => send('plugins-settings', { id }),
    configure: (id, set, unset) => send('plugins-configure', { id, set, unset }, true)
  }
}
