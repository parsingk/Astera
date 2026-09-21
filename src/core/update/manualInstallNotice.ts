import type { Message } from '../i18n'
import type { InstallOutcome } from '../types'

/**
 * What to tell the person once the install button has done its work.
 *
 * Null on the automatic path is not an omission: the app quits within the same tick, so anything
 * put on screen there would flash and vanish. The other two branches are the whole reason this
 * function exists — before them, a macOS install that Squirrel had already refused produced no
 * quit, no message and no way to tell the difference from a dead button.
 */
export function installOutcomeNotice(outcome: InstallOutcome): Message | null {
  switch (outcome.mode) {
    case 'auto':
      return null
    case 'manual':
      return { key: 'update.manual.done', params: { path: outcome.appPath } }
    case 'failed':
      return { key: 'update.manual.failed', params: { message: outcome.message } }
  }
}
