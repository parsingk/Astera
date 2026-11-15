// The permission policy of spec 3.3 (Ruling E5): a reviewer may read and may not change anything.
// A read, search or think request selects the first allow_once option, never allow_always. Everything
// else (and a request that is malformed, has no such option, or belongs to another session) selects the
// first reject_once option, or answers cancelled when there is none.

export const READ_KINDS: readonly string[] = ['read', 'search', 'think']
export const WRITE_KINDS: readonly string[] = ['edit', 'delete', 'move']

export type PermissionAnswer =
  | { outcome: { outcome: 'selected'; optionId: string }; allowed: boolean }
  | { outcome: { outcome: 'cancelled' }; allowed: false }

const CANCELLED: PermissionAnswer = { outcome: { outcome: 'cancelled' }, allowed: false }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function firstOption(options: unknown[], kind: string): string | undefined {
  for (const o of options) {
    if (isObject(o) && o.kind === kind && typeof o.optionId === 'string') return o.optionId
  }
  return undefined
}

/** Spec 3.3 "Permission policy". `params` is the raw request; anything malformed is refused. */
export function decidePermission(sessionId: string, params: unknown): PermissionAnswer {
  if (!isObject(params) || !Array.isArray(params.options)) return CANCELLED
  const kind = isObject(params.toolCall) ? params.toolCall.kind : undefined
  if (params.sessionId === sessionId && typeof kind === 'string' && READ_KINDS.includes(kind)) {
    const allow = firstOption(params.options, 'allow_once')
    if (allow !== undefined) return { outcome: { outcome: 'selected', optionId: allow }, allowed: true }
  }
  const reject = firstOption(params.options, 'reject_once')
  return reject === undefined ? CANCELLED : { outcome: { outcome: 'selected', optionId: reject }, allowed: false }
}
