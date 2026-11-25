// `astera plugins install` (plugin runtime design P6): what the Host is asked, in what order. The folder is inspected
// first; without `--yes` or `--grant` nothing is installed and the person is shown what the plugin is and asks for.
// The install then carries what was shown (`expect`), so the Host refuses a folder that changed in between.
import path from 'node:path'
import { PLUGIN_RESTRICTED_UI_NOTICE, PLUGIN_TRUST_WARNING } from '../core/plugins/manifest'

/** What one Host call came back as: an answer, or none (`callHost`). */
export type PluginCall = { status: number; body: unknown } | { unreachable: string } | { stuck: string }

/** The sentence a person reads before approving (spec §31). Inside an agent session the approval would be refused,
 *  so it says who can give it instead of how. */
export function approvalMessage(inspection: Record<string, unknown>, o: { agent?: boolean } = {}): string {
  const permissions = Array.isArray(inspection.permissions) ? (inspection.permissions as string[]) : []
  const asks = permissions.length > 0 ? permissions.join(', ') : 'no permissions'
  const installed = inspection.installed as { version?: unknown } | undefined
  const replaces = installed && typeof installed.version === 'string' ? ` It replaces the installed ${installed.version}.` : ''
  const wontRun = inspection.compatible === false && typeof inspection.reason === 'string' ? ` It will not run here: ${inspection.reason}.` : ''
  // A package file is approved by what it is: the file, and the sha256 of the bytes that will install (final review m8)
  const shown = (typeof inspection.source === 'object' && inspection.source !== null ? inspection.source : {}) as Record<string, unknown>
  const from = typeof shown.file === 'string' && typeof shown.sha256 === 'string' ? ` From ${shown.file}, sha256 ${shown.sha256}.` : ''
  const how = o.agent
    ? ' Installing it is for a person at their own shell or in the Astera app, not an agent session (ASTERA_SESSION is set): ask them to run astera plugins install with --yes.'
    : ' Approve with --yes, or name what to grant with --grant <list>.'
  // ADR-008: a plugin with a UI and no host entry is restricted UI; anything else, or a Host that does not say, is trusted code
  const trust = inspection.trust === 'restricted-ui' ? PLUGIN_RESTRICTED_UI_NOTICE : PLUGIN_TRUST_WARNING
  return (
    `${String(inspection.displayName)} ${String(inspection.version)} (${String(inspection.id)}) asks for: ${asks}.${from}${replaces} ` +
    `${trust}${wontRun}${how}`
  )
}

/** How `plugins doctor` ends when a check failed: FAILED (exit 1), naming each failing check, with the checks in the
 *  details. Null when every check passed. */
export function doctorEnd(body: unknown): { code: 'FAILED'; message: string; details: Record<string, unknown> } | null {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (b.ok !== false) return null
  const failing = (Array.isArray(b.checks) ? (b.checks as Record<string, unknown>[]) : []).filter((c) => c.ok !== true)
  return {
    code: 'FAILED',
    message: `${String(b.id)} has problems: ${failing.map((c) => `${String(c.name)}: ${String(c.detail)}`).join('; ')}`,
    details: b
  }
}

/** `plugins configure`'s flags as the Host takes them (plugins 2c): `--set key=value` (split at the first `=`, as many
 *  as given), `--unset key`, and `--stdin key`, whose value is what standard input held with one trailing newline
 *  dropped, so a secret stays off the command line. */
export function configureArgs(
  args: Record<string, unknown>,
  stdinText: string | undefined
): { args: Record<string, unknown> } | { error: string } {
  const { set: rawSet, unset: rawUnset, stdin, ...rest } = args
  const set: Record<string, string> = {}
  const put = (key: string, value: string): string | null => {
    if (Object.hasOwn(set, key)) return `${key} is set twice`
    set[key] = value
    return null
  }
  for (const pair of Array.isArray(rawSet) ? (rawSet as unknown[]) : rawSet === undefined ? [] : [rawSet]) {
    const text = String(pair)
    const at = text.indexOf('=')
    // The text is not repeated (2c final review I5): a --set without its key may be the secret itself.
    if (at < 0) return { error: '--set needs key=value, and one has no =' }
    if (at === 0) return { error: '--set needs key=value, and one has no key before its =' }
    const twice = put(text.slice(0, at), text.slice(at + 1))
    if (twice) return { error: twice }
  }
  if (stdin !== undefined) {
    if (typeof stdin !== 'string' || stdin === '') return { error: '--stdin needs the key to set' }
    if (stdinText === undefined || stdinText === '') return { error: `--stdin ${stdin} read nothing from standard input` }
    const twice = put(stdin, stdinText.replace(/\r?\n$/, ''))
    if (twice) return { error: twice }
  }
  const unset = Array.isArray(rawUnset) ? (rawUnset as unknown[]).map(String) : rawUnset === undefined ? [] : [String(rawUnset)]
  return {
    args: { ...rest, ...(Object.keys(set).length > 0 ? { set } : {}), ...(unset.length > 0 ? { unset } : {}) }
  }
}

/** Why `plugins configure` refuses a `-` for a flag's value, or null (2c final review I5): it reads standard input only for
 *  `--stdin <key>`, and a `-` would have it read standard input twice, the second time for nothing. Asked before
 *  standard input is read at all. */
export function configureStdinError(wantsStdin: readonly string[]): string | null {
  if (wantsStdin.length === 0) return null
  const flags = wantsStdin.map((k) => `--${k}`).join(' or ')
  return `plugins configure reads standard input only as --stdin <key>, as in --stdin token; a - after ${flags} is not one`
}

/** `--grant a,b`: the names, trimmed, with empty ones dropped. */
const grantOf = (v: unknown): string[] | null =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    : null

export async function installPlugin<R extends PluginCall>(a: {
  args: Record<string, unknown>
  /** The shell's folder: a relative --path means one there, not one beside the Host. */
  cwd: string
  /** The request id this invocation carries; it goes on the install, the call that acts. */
  request: string | undefined
  call: (cmd: string, args: Record<string, unknown>, request: string | undefined) => Promise<R>
  /** What a person already approved (`plugins dev`): a folder asking for anything else is refused before the install, and
   *  the approved trust is what the Host must find in the copy it installs. */
  approved?: { trust: string; permissions: string[]; capabilities: string[] }
}): Promise<R | { status: number; body: unknown } | { approve: Record<string, unknown> }> {
  const given = a.args.path
  const pkg = a.args.npm
  const file = a.args.file
  if ([given, pkg, file].filter((v) => v !== undefined).length > 1) return { status: 400, body: { error: 'plugins install takes one of --path, --npm and --file' } }
  // A folder or a package file (`plugins pack`), resolved against the shell's own; or a package on npm (plugins 2e), as
  // the person wrote it.
  const source =
    typeof pkg === 'string' && pkg !== ''
      ? { npm: pkg }
      : typeof given === 'string' && given !== ''
        ? { path: path.resolve(a.cwd, given) }
        : typeof file === 'string' && file !== ''
          ? { file: path.resolve(a.cwd, file) }
          : null
  if (source === null) return { status: 400, body: { error: 'plugins install needs --path <folder>, --npm <package> or --file <package.tgz>' } }
  // The parser reads a bare `--grant` as true; read as "no list", --yes would then grant everything.
  if (a.args.grant === true) return { status: 400, body: { error: '--grant needs a list of permissions; --grant "" grants none' } }
  const shown = await a.call('plugins-inspect', source, undefined)
  if (!('status' in shown) || shown.status !== 200) return shown
  const inspection = shown.body as Record<string, unknown>
  const named = grantOf(a.args.grant)
  if (named === null && a.args.yes !== true) return { approve: inspection }
  const grant = named ?? (Array.isArray(inspection.permissions) ? (inspection.permissions as string[]) : [])
  // The trust level shown goes too, so a folder that changed it in between is refused (final review M7); a package file's
  // sha256 too, so the bytes installed are the bytes shown
  const trust = typeof inspection.trust === 'string' ? { trust: inspection.trust } : {}
  const shownSource = (typeof inspection.source === 'object' && inspection.source !== null ? inspection.source : {}) as Record<string, unknown>
  const sha256 = 'file' in source && typeof shownSource.sha256 === 'string' ? { sha256: shownSource.sha256 } : {}
  if (a.approved) {
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const same = (x: string[], y: string[]): boolean => x.length === y.length && [...x].sort().join('\n') === [...y].sort().join('\n')
    if (inspection.trust !== a.approved.trust || !same(strings(inspection.permissions), a.approved.permissions) || !same(strings(inspection.capabilities), a.approved.capabilities))
      return { status: 409, body: { error: 'the folder asks for something other than what was approved; run plugins dev again to approve it' } }
    return a.call('plugins-install', { ...source, grant, expect: { name: inspection.name, version: inspection.version, trust: a.approved.trust, ...sha256 } }, a.request)
  }
  return a.call('plugins-install', { ...source, grant, expect: { name: inspection.name, version: inspection.version, ...trust, ...sha256 } }, a.request)
}
