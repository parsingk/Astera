// `astera audit list|summary` and `astera policies show|set-mode|set-otherwise|rules-add|rules-edit|rules-remove|
// rules-move|rules-reset` (observe mode design §12). The Host answers them (host/audit/auditCommands.ts and
// policyCommands.ts), as it answers `agent-profiles`; this file turns the line into their arguments. Three things are done
// here first: an agent profile named by its name is resolved to its id with `agent-profiles-get`, as the profile
// commands resolve one; the places `--at` and `--to` become numbers; and `--clear-scope` becomes the Host's
// `scope: null`. Whether a value is one the Host takes (an action, a mode, a time) is the Host's to say.

type Answer = { status: number; body: unknown }

type Call<R> = (cmd: string, args: Record<string, unknown>, request: string | undefined) => Promise<R>

const bad = (error: string): Answer => ({ status: 400, body: { error } })

const isAnswer = (r: unknown): r is Answer => typeof r === 'object' && r !== null && 'status' in r

/** A flag's text, or why it cannot be used: the parser reads a bare `--name` as `true`, and an empty value names nothing. */
const text = (flag: string, v: unknown): string | { error: string } =>
  typeof v === 'string' && v !== '' ? v : { error: `--${flag} needs a value` }

/** A place in the rule list, counted from 0. Whether the list is that long is the Host's to say. */
const place = (flag: string, v: unknown): number | { error: string } =>
  typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : { error: `--${flag} must be a place in the list, from 0` }

/** `audit list`'s and `audit summary`'s flags: as typed, as the parser keys them, and as the Host names them. */
const FILTERS = [
  ['session', 'session', 'sessionId'],
  ['job', 'job', 'jobId'],
  ['run', 'run', 'runId'],
  ['task', 'task', 'taskId'],
  ['action', 'action', 'action'],
  ['decision', 'decision', 'decision'],
  ['since', 'since', 'since'],
  ['until', 'until', 'until'],
  ['before-id', 'beforeId', 'beforeId']
] as const

/** An agent profile's id as the store makes it (core/agentProfiles/store.ts). The records of a profile deleted since still
 *  carry it, so it filters them though the lookup no longer finds the profile. */
const PROFILE_ID = /^ap_[0-9a-f]{12}$/

export async function auditCommand<R extends object>(a: {
  cmd: string
  args: Record<string, unknown>
  /** The request id this invocation carries; it goes on the read itself, not on the profile lookup. */
  request: string | undefined
  call: Call<R>
  /** Run in an agent's shell (`ASTERA_SESSION` is set): the Host refuses it every audit command (5), so the command goes
   *  as it is, with no flag checked and no name looked up first, or a name that matches nothing would answer 4 before it. */
  agentSession?: boolean
}): Promise<R | Answer> {
  if (a.agentSession === true) return a.call(a.cmd, {}, a.request)
  const sent: Record<string, unknown> = {}
  for (const [flag, key, hostKey] of FILTERS) {
    if (a.args[key] === undefined) continue
    const v = text(flag, a.args[key])
    if (typeof v !== 'string') return bad(v.error)
    sent[hostKey] = v
  }
  // A number already (the parser's NUMERIC); one out of range is the Host's to refuse
  if (a.args.limit !== undefined) sent.limit = a.args.limit
  if (a.args.agentProfile !== undefined) {
    const idOrName = text('agent-profile', a.args.agentProfile)
    if (typeof idOrName !== 'string') return bad(idOrName.error)
    const found = await a.call('agent-profiles-get', { idOrName }, undefined)
    if (!isAnswer(found)) return found
    if (found.status === 404 && PROFILE_ID.test(idOrName)) sent.agentProfileId = idOrName
    else if (found.status !== 200) return found
    else {
      const id = (found.body as { profile?: { id?: unknown } } | null)?.profile?.id
      if (typeof id !== 'string') return { status: 500, body: { error: 'the Host answered agent-profiles-get without a profile' } }
      sent.agentProfileId = id
    }
  }
  return a.call(a.cmd, sent, a.request)
}

export async function policiesCommand<R extends object>(a: {
  cmd: string
  args: Record<string, unknown>
  /** The request id this invocation carries. */
  request: string | undefined
  call: Call<R>
}): Promise<R | Answer> {
  const { cmd, args } = a
  const send = (sent: Record<string, unknown>): Promise<R> => a.call(cmd, sent, a.request)
  /** A required flag's text, or why there is none. */
  const required = (flag: string, key: string, what: string): string | { error: string } =>
    args[key] === undefined ? { error: `--${flag} is required: ${what}` } : text(flag, args[key])

  switch (cmd) {
    case 'policies-show':
    case 'policies-rules-reset':
      return send({})
    case 'policies-set-mode': {
      const mode = required('mode', 'mode', 'compatibility or observe')
      return typeof mode === 'string' ? send({ mode }) : bad(mode.error)
    }
    case 'policies-set-otherwise': {
      // `--effect`, as a rule's: the Host calls this one `otherwise`
      const effect = required('effect', 'effect', 'allow or deny')
      return typeof effect === 'string' ? send({ otherwise: effect }) : bad(effect.error)
    }
    case 'policies-rules-add': {
      const effect = required('effect', 'effect', 'allow or deny')
      if (typeof effect !== 'string') return bad(effect.error)
      const action = required('action', 'action', 'the action it matches, or the start of one ending in * (git.*)')
      if (typeof action !== 'string') return bad(action.error)
      const sent: Record<string, unknown> = { effect, action }
      if (args.scope !== undefined) {
        const scope = text('scope', args.scope)
        if (typeof scope !== 'string') return bad(scope.error)
        sent.scope = scope
      }
      if (args.at !== undefined) {
        const at = place('at', args.at)
        if (typeof at !== 'number') return bad(at.error)
        sent.at = at
      }
      return send(sent)
    }
    case 'policies-rules-edit': {
      const id = required('id', 'id', 'the rule (from `policies show`)')
      if (typeof id !== 'string') return bad(id.error)
      const sent: Record<string, unknown> = { id }
      for (const key of ['effect', 'action', 'scope'] as const) {
        if (args[key] === undefined) continue
        const v = text(key, args[key])
        if (typeof v !== 'string') return bad(v.error)
        sent[key] = v
      }
      if (args.clearScope !== undefined) {
        if (args.clearScope !== true) return bad('--clear-scope takes no value')
        if (sent.scope !== undefined) return bad('give --scope or --clear-scope, not both')
        // The Host's way to say the rule matches wherever the call was
        sent.scope = null
      }
      return send(sent)
    }
    case 'policies-rules-remove': {
      const id = required('id', 'id', 'the rule (from `policies show`)')
      return typeof id === 'string' ? send({ id }) : bad(id.error)
    }
    case 'policies-rules-move': {
      const id = required('id', 'id', 'the rule (from `policies show`)')
      if (typeof id !== 'string') return bad(id.error)
      if (args.to === undefined) return bad('--to is required: its new place in the list, from 0')
      const to = place('to', args.to)
      return typeof to === 'number' ? send({ id, to }) : bad(to.error)
    }
  }
  return { status: 501, body: { error: `${cmd} is not a policies command` } }
}
