// Answers Claude Code's AskUserQuestion dialog with the card's answers, one screen at a time.
//
// The rule is the one `stepToward` set for the banner's arrow walk (core/history/promptChoices.ts): a
// plan made against a screen that has moved on confirms the wrong thing, and the key it is wrong about
// is the last one. So nothing here is planned ahead. Every step reads the screen (core/prompts/
// askScreen.ts), decides one screen's worth of keys from what it shows, sends them, and waits for the
// stage to change before reading again. The final Enter is pressed only against a review that lists
// exactly the answers the card chose.
//
// A stop leaves the dialog exactly where it is: the person finishes on the terminal, where the screen
// already shows what this saw. Nothing here ever presses Esc or Cancel.
import type { AskForm, Answer } from '../../../../core/prompts/askUserQuestion'
import { askStageOf, reviewMatches, type AskStage } from '../../../../core/prompts/askScreen'
import { keysForQuestion, advanceFor, TAB, ENTER } from '../../../../core/prompts/askKeys'

export type AskStopReason =
  /** The dialog is not on the screen: answered on the terminal, or the CLI moved on. */
  | 'dialog-gone'
  /** The dialog has been moved on the terminal; driving it from here would mean guessing its focus. */
  | 'not-pristine'
  /** A key produced no change on screen within the wait. */
  | 'no-change'
  /** The same question came back after its keys, or the step budget ran out. */
  | 'stuck'
  /** The review lists something other than what the card chose, or Submit is not highlighted. */
  | 'review-mismatch'

export type AskOutcome = { outcome: 'submitted' } | { outcome: 'stopped'; reason: AskStopReason; stage: AskStage }

/** Between two keys. The banner's arrow walk uses the same 120 ms (ConversationPane.tsx's ARROW_STEP_MS). */
export const KEY_GAP_MS = 120
/** How long a stage may take to change after a key before the driver gives up on it. */
export const STAGE_WAIT_MS = 1500
export const STAGE_POLL_MS = 100

export async function driveAsk(a: {
  form: AskForm
  answers: Answer[]
  /** The live screen (sessionBus.screenOf), or null when no terminal is registered for the session. */
  readScreen: () => string | null
  /** One write to the pty (window.api.sessions.write). */
  write: (keys: string) => void
  wait: (ms: number) => Promise<void>
}): Promise<AskOutcome> {
  const read = (): AskStage => {
    const screen = a.readScreen()
    return screen === null ? { kind: 'none' } : askStageOf(screen.split('\n'), a.form)
  }
  const same = (x: AskStage, y: AskStage): boolean => JSON.stringify(x, mapAsList) === JSON.stringify(y, mapAsList)
  const waitForChange = async (before: AskStage): Promise<AskStage> => {
    for (let waited = 0; waited < STAGE_WAIT_MS; waited += STAGE_POLL_MS) {
      await a.wait(STAGE_POLL_MS)
      const now = read()
      if (!same(now, before)) return now
    }
    return before
  }
  const stopped = (reason: AskStopReason, stage: AskStage): AskOutcome => ({ outcome: 'stopped', reason, stage })

  let stage = read()
  if (stage.kind === 'none') return stopped('dialog-gone', stage)
  if (stage.kind !== 'question' || stage.index !== 0 || !stage.pristine) return stopped('not-pristine', stage)

  const done = new Set<number>()
  const budget = a.form.questions.length * 8 + 4
  for (let step = 0; step < budget; step++) {
    if (stage.kind === 'none') return stopped('dialog-gone', stage)
    if (stage.kind === 'review') {
      if (!stage.ready || !reviewMatches(stage, a.form, a.answers)) return stopped('review-mismatch', stage)
      a.write(ENTER)
      return { outcome: 'submitted' }
    }
    // A multi-select's own Submit row, reached by Tab from text mode: Enter moves on.
    if (stage.submitRowFocused) {
      a.write(ENTER)
      const next = await waitForChange(stage)
      if (same(next, stage)) return stopped('no-change', next)
      stage = next
      continue
    }
    if (done.has(stage.index)) return stopped('stuck', stage)
    const question = a.form.questions[stage.index]
    const answer = a.answers[stage.index]
    const keys = keysForQuestion(question, answer)
    for (const key of keys) {
      a.write(key)
      await a.wait(KEY_GAP_MS)
    }
    const advance = advanceFor(question, answer)
    if (advance === 'enter') a.write(ENTER)
    else if (advance === 'tab') a.write(TAB)
    done.add(stage.index)
    const next = await waitForChange(stage)
    if (same(next, stage)) return stopped('no-change', next)
    stage = next
  }
  return stopped('stuck', stage)
}

/** JSON.stringify drops a Map; the review's answers are what makes two review stages differ. */
function mapAsList(_key: string, value: unknown): unknown {
  return value instanceof Map ? [...value.entries()] : value
}
