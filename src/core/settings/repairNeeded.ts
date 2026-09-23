// A profile file that only the app may repair could not be read.

/**
 * **What the four read-only readers of the app's files throw** when a file is there and cannot be
 * read: accounts.json (`core/accounts/accountsFile.ts`), run-configs.json (`core/run/runConfigsFile.ts`),
 * and app-settings.json (`core/settings/agentPermissionMode.ts`, `readSkillSettings`). The app is each
 * file's only writer and repairs it at its next start, so the reader refuses rather than guess, and
 * the message says to open Astera.
 *
 * **A type with the file as a field, not a sentence to match on.** The Host answers such a refusal
 * as a conflict (409, exit 6) carrying `repair: <file>`, and the CLI then offers no command to run
 * (`STEPS.CONFLICT`), because the step is opening Astera, which no command does. Both decisions read
 * `file`, never the message, which is the rule `AppUnreachable` keeps for the same reason.
 */
export class RepairNeeded extends Error {
  constructor(
    message: string,
    /** The profile file's own name, e.g. `accounts.json`. */
    readonly file: string
  ) {
    super(message)
  }
}
