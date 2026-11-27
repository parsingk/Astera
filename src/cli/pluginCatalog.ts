// The CLI's catalog flows (Phase 4): the catalog source as the Host takes it, an install from the catalog in two calls
// (shown first, installed only with an approval, carrying exactly what was shown), Safe Mode with or without a Host,
// and turning every plugin off. Each Host call goes through `call`, as `plugins install` does (cli/plugins.ts).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AUDIT_FILE, createPluginAudit } from '../core/plugins/pluginAudit'
import { grantOf, type PluginCall } from './plugins'

/** `plugins catalog-configure`'s flags as the Host takes them: `--url` with `--key id=publicKey[,id=publicKey]`, or `--clear`. */
export function catalogConfigureArgs(args: Record<string, unknown>): { args: Record<string, unknown> } | { error: string } {
  if (args.clear === true) {
    if (args.url !== undefined || args.key !== undefined) return { error: 'plugins catalog-configure takes --clear alone, or --url with --key' }
    return { args: { clear: true } }
  }
  if (typeof args.url !== 'string' || args.key === undefined) return { error: 'plugins catalog-configure needs --url <index> and --key <id=publicKey>, or --clear' }
  const keys: { id: string; publicKey: string }[] = []
  // Comma separated, as --grant is: a key's base64 holds no comma, and two keys let a registry rotate its key
  for (const text of String(args.key).split(',').map((x) => x.trim()).filter((x) => x !== '')) {
    const at = text.indexOf('=')
    if (at <= 0) return { error: '--key needs id=publicKey, and one has no =' }
    keys.push({ id: text.slice(0, at), publicKey: text.slice(at + 1) })
  }
  return { args: { url: args.url, keys } }
}

/** `plugins catalog-install`: the catalog's package is shown (`plugins-catalog-inspect`, no request id), and only an
 *  approval (`--yes` or `--grant`) sends the install, with what was shown as `expect` and this invocation's request id. */
export async function catalogInstall<R extends PluginCall>(a: {
  args: Record<string, unknown>
  request: string | undefined
  call: (cmd: string, args: Record<string, unknown>, request: string | undefined) => Promise<R>
}): Promise<R | { status: number; body: unknown } | { approve: Record<string, unknown> }> {
  if (typeof a.args.id !== 'string' || a.args.id === '') return { status: 400, body: { error: 'plugins catalog-install needs --id <pluginId> (from plugins catalog)' } }
  if (a.args.grant === true) return { status: 400, body: { error: '--grant needs a list of permissions; --grant "" grants none' } }
  const shown = await a.call('plugins-catalog-inspect', { id: a.args.id, ...(typeof a.args.version === 'string' ? { version: a.args.version } : {}) }, undefined)
  if (!('status' in shown) || shown.status !== 200) return shown
  const inspection = shown.body as Record<string, unknown>
  const named = grantOf(a.args.grant)
  if (named === null && a.args.yes !== true) return { approve: inspection }
  const grant = named ?? (Array.isArray(inspection.permissions) ? (inspection.permissions as string[]) : [])
  const catalog = (typeof inspection.catalog === 'object' && inspection.catalog !== null ? inspection.catalog : {}) as Record<string, unknown>
  return a.call(
    'plugins-catalog-install',
    {
      id: a.args.id,
      version: inspection.version,
      grant,
      expect: { name: inspection.id, version: inspection.version, sha256: catalog.sha256, ...(typeof inspection.trust === 'string' ? { trust: inspection.trust } : {}) }
    },
    a.request
  )
}

/** `plugins safe-mode`: `--on` or `--off`. */
export function safeModeArgs(args: Record<string, unknown>): { on: boolean } | { error: string } {
  if ((args.on === true) === (args.off === true)) return { error: 'plugins safe-mode needs --on or --off' }
  return { on: args.on === true }
}

/** Safe Mode set with no Host running: the profile's file, which a Host that starts reads (host/plugins/manager.ts). */
export async function setSafeModeOffline(profileDir: string, on: boolean): Promise<{ safeMode: boolean; changed: boolean; offline: true }> {
  const file = path.join(profileDir, 'plugins', 'safe-mode')
  const was = await fs.stat(file).then(() => true, () => false)
  if (was === on) return { safeMode: on, changed: false, offline: true }
  if (on) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '')
  } else await fs.rm(file, { force: true })
  // Recorded where the Host records Safe Mode, so the history has it whoever set it (final review m9)
  const audit = createPluginAudit({ file: path.join(profileDir, 'plugins', AUDIT_FILE) })
  audit.record({ plugin: '*', event: on ? 'disabled' : 'enabled', by: 'cli', detail: `Safe Mode ${on ? 'on' : 'off'}, set with no Host running` })
  await audit.drain()
  return { safeMode: on, changed: true, offline: true }
}

/** `plugins disable --all`: every enabled plugin turned off, one call each, so each is recorded as its own change. */
export async function disableAll<R extends PluginCall>(a: {
  call: (cmd: string, args: Record<string, unknown>, request: string | undefined) => Promise<R>
}): Promise<R | { status: number; body: { error?: string; disabled: string[]; failed: { id: string; error: string }[] } }> {
  const listed = await a.call('plugins-list', {}, undefined)
  if (!('status' in listed) || listed.status !== 200) return listed
  const plugins = (listed.body as { plugins?: unknown }).plugins
  const disabled: string[] = []
  const failed: { id: string; error: string }[] = []
  for (const p of Array.isArray(plugins) ? (plugins as Record<string, unknown>[]) : []) {
    if (p.enabled !== true || typeof p.id !== 'string') continue
    const r = await a.call('plugins-disable', { id: p.id }, undefined)
    if ('status' in r && r.status === 200) disabled.push(p.id)
    else failed.push({ id: p.id, error: 'status' in r ? String((r.body as { error?: unknown }).error ?? r.status) : 'unreachable' in r ? r.unreachable : r.stuck })
  }
  // Each plugin it could not turn off fails the command, named (final review m8)
  if (failed.length > 0)
    return {
      status: 409,
      body: { error: `${failed.length} ${failed.length === 1 ? 'plugin' : 'plugins'} could not be turned off: ${failed.map((f) => `${f.id} (${f.error})`).join(', ')}`, disabled, failed }
    }
  return { status: 200, body: { disabled, failed } }
}
