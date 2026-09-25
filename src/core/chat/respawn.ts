// What a roll's respawn of a chat session hands ChatSessionManager.spawn (chat takeover Task 2). The
// app's roll callbacks and the Host's both build the manager's options from the coordinators' respawn
// request by this one mapping, so the two never disagree about what a rolled chat session carries: the
// thread to resume, the carry-on, the chain, the person's model pick, the toolchain bypass the chain was
// granted, and the old session's unattended policy (the policy is the session's, and the session is the
// chain, so it rides the roll).
//
// Imports only core, so the Host bundle can carry it.
import type { Account } from '../types'
import type { RollSpawnExtra } from '../rolling/snapshot'
import type { BypassSignal } from '../sessions/retryBypass'
import type { UnattendedPermission } from './types'
import type { ChatSpawnOpts } from './manager'

/** A coordinator's respawn request for a chat session, in the coordinators' own words
 *  (`resumeSessionId`, not the manager's `resumeThreadId`). */
export interface ChatRollSpawn {
  account: Account
  cwd: string
  resumeSessionId?: string
  initialPrompt?: string
  rollAccountIds?: string[]
  rollPrompt?: string
  slackNotify?: boolean
  bypassPermissions?: boolean
  title?: string
  model?: string | null
  startWithBypass?: boolean
  restoreExtra?: RollSpawnExtra
}

/** The manager's spawn options for a roll respawn. The policy is asked of the session the roll came
 *  from (`restoreExtra.rolledFrom`), and of `undefined` when the request names none, which answers
 *  'hold'. `hostStarting` is set only by the Host, for a proc it spawns (plan ruling P5). Every optional
 *  key is present only when the request gave it, so the manager's own defaults hold otherwise. */
export function chatSpawnOptsOf(
  o: ChatRollSpawn,
  d: { unattendedOf(sessionId: string | undefined): UnattendedPermission; bypassSignal: BypassSignal; hostStarting?: boolean }
): ChatSpawnOpts {
  return {
    account: o.account,
    cwd: o.cwd,
    ...(o.resumeSessionId !== undefined ? { resumeThreadId: o.resumeSessionId } : {}),
    ...(o.initialPrompt !== undefined ? { initialPrompt: o.initialPrompt } : {}),
    ...(o.rollAccountIds !== undefined ? { rollAccountIds: o.rollAccountIds } : {}),
    ...(o.rollPrompt !== undefined ? { rollPrompt: o.rollPrompt } : {}),
    ...(o.slackNotify !== undefined ? { slackNotify: o.slackNotify } : {}),
    ...(o.bypassPermissions !== undefined ? { bypassPermissions: o.bypassPermissions } : {}),
    ...(o.title !== undefined ? { title: o.title } : {}),
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.startWithBypass !== undefined ? { startWithBypass: o.startWithBypass } : {}),
    ...(o.restoreExtra !== undefined ? { restoreExtra: o.restoreExtra } : {}),
    bypassSignal: d.bypassSignal,
    unattendedPermission: d.unattendedOf(o.restoreExtra?.rolledFrom),
    ...(d.hostStarting ? { hostStarting: true } : {})
  }
}
