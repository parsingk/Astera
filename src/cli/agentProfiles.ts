// `astera agent-profiles list|show|create|update|archive|restore|delete` (Agent Profiles design §6). The Host answers
// them (host/agentProfiles/commands.ts), as it answers `sessions`; this file turns the line into its commands. Two
// things are done here first: a profile named by its name is resolved to its id with `agent-profiles-get`, since the
// changes take the id, and the shared MCP servers `--exclude-mcp` names are turned into their registry ids, which is
// what a profile keeps. A name no shared server has is refused here, naming it, before anything is sent. `--sandbox
// on|off` is sent as the boolean the Host takes, and `archive --reason` as the line the Host records (lifecycle §5).
import type { ExtensionEntry } from '../core/extensions/types'

type Answer = { status: number; body: unknown }

const bad = (error: string): Answer => ({ status: 400, body: { error } })

/** A flag's text, or why it cannot be used: the parser reads a bare `--name` as `true`. */
const text = (flag: string, v: unknown): string | { error: string } =>
  typeof v === 'string' ? v : { error: `--${flag} needs a value` }

/** `a, b,` → `['a', 'b']`: trimmed, the empty ones dropped. */
const list = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

const isAnswer = (r: unknown): r is Answer => typeof r === 'object' && r !== null && 'status' in r

export async function agentProfilesCommand<R extends object>(a: {
  cmd: string
  args: Record<string, unknown>
  /** The request id this invocation carries; it goes on the change, the call that acts. */
  request: string | undefined
  call: (cmd: string, args: Record<string, unknown>, request: string | undefined) => Promise<R>
  /** The shared extensions, for `--exclude-mcp`; read only when that flag is given. */
  mcpEntries: () => Promise<ExtensionEntry[]>
}): Promise<R | Answer> {
  const { cmd, args } = a
  if (cmd === 'agent-profiles-list') return a.call('agent-profiles-list', {}, a.request)

  // The fields a create or an update sends, from the flags given
  const fields = async (): Promise<Record<string, unknown> | { error: string } | { refused: Answer }> => {
    const out: Record<string, unknown> = {}
    for (const [flag, key] of [
      ['name', 'name'],
      ['permission', 'permission'],
      ['description', 'description']
    ] as const) {
      if (args[key] === undefined) continue
      const v = text(flag, args[key])
      if (typeof v !== 'string') return v
      out[key] = v
    }
    if (args.account !== undefined) {
      const v = text('account', args.account)
      if (typeof v !== 'string') return v
      out.accountIds = list(v)
    }
    // The sandbox switch (sandbox design §6), as words a person types: anything but on or off is refused, never guessed
    if (args.sandbox !== undefined) {
      if (args.sandbox !== 'on' && args.sandbox !== 'off') return { error: '--sandbox is on or off' }
      out.sandbox = args.sandbox === 'on'
    }
    if (args.excludeMcp !== undefined) {
      const v = text('exclude-mcp', args.excludeMcp)
      if (typeof v !== 'string') return v
      const names = list(v)
      let entries: ExtensionEntry[] = []
      try {
        if (names.length > 0) entries = await a.mcpEntries()
      } catch (e) {
        // A damaged registry is the person's to repair in Astera, as `ext list` says (cli/extensions.ts)
        return { refused: { status: 409, body: { error: `the shared extensions could not be read: ${e instanceof Error ? e.message : String(e)}`, repair: 'extensions/registry.json' } } }
      }
      const servers = entries.filter((e) => e.kind === 'mcp')
      const unknown = names.filter((n) => !servers.some((e) => e.name === n))
      if (unknown.length > 0)
        return { error: `no shared MCP server is named ${unknown.join(', ')} (astera ext list names them)` }
      out.mcpExclude = names.flatMap((n) => servers.filter((e) => e.name === n).map((e) => e.id))
    }
    return out
  }

  if (cmd === 'agent-profiles-create') {
    if (args.name === undefined) return bad('--name is required: what to call the profile')
    if (args.account === undefined) return bad('--account is required: its accounts, in the order they are tried (from `accounts list`)')
    const f = await fields()
    if ('refused' in f) return f.refused as Answer
    if ('error' in f) return bad(f.error as string)
    const created = await a.call('agent-profiles-create', f, a.request)
    return unwrap(created)
  }

  // The archive's reason (lifecycle design §5), refused before anything is sent when given bare; the Host checks the rest
  const reason = cmd === 'agent-profiles-archive' && args.reason !== undefined ? text('reason', args.reason) : undefined
  if (typeof reason === 'object') return bad(reason.error)

  // The rest name one profile, by its id or its name
  if (args.id === undefined) return bad('--id is required: the profile id or name (from `agent-profiles list`)')
  const idOrName = text('id', args.id)
  if (typeof idOrName !== 'string' || idOrName === '') return bad('--id needs a value: the profile id or name')
  // `show` is this one read, so it carries the request id as any read does; before a change it is a lookup and does not
  const found = await a.call('agent-profiles-get', { idOrName }, cmd === 'agent-profiles-show' ? a.request : undefined)
  if (!isAnswer(found) || found.status !== 200) return found
  const profile = (found.body as { profile?: { id?: unknown; name?: unknown } }).profile
  if (cmd === 'agent-profiles-show') return unwrap(found)
  if (typeof profile?.id !== 'string') return { status: 500, body: { error: 'the Host answered agent-profiles-get without a profile' } }
  const id = profile.id

  if (cmd === 'agent-profiles-update') {
    const f = await fields()
    if ('refused' in f) return f.refused as Answer
    if ('error' in f) return bad(f.error as string)
    return unwrap(await a.call('agent-profiles-update', { id, ...f }, a.request))
  }
  if (cmd === 'agent-profiles-archive') return unwrap(await a.call(cmd, { id, ...(reason !== undefined ? { reason } : {}) }, a.request))
  if (cmd === 'agent-profiles-restore') return unwrap(await a.call(cmd, { id }, a.request))
  if (cmd === 'agent-profiles-delete') {
    const deleted = await a.call('agent-profiles-delete', { id }, a.request)
    if (!isAnswer(deleted) || deleted.status !== 200) return deleted
    return { status: 200, body: { id, name: profile.name, deleted: true } }
  }
  return { status: 501, body: { error: `${cmd} is not an agent-profiles command` } }
}

/** One profile answered as `{ profile }`, printed as the profile itself, as `jobs get` prints a Job. */
function unwrap<R extends object>(r: R): R | Answer {
  if (!isAnswer(r) || r.status !== 200) return r
  const profile = (r.body as { profile?: unknown } | null)?.profile
  return profile === undefined ? r : { ...r, body: profile }
}
