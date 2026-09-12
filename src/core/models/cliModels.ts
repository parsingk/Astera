/** A model a session can be switched to, and how its CLI is told to switch. */
export interface CliModelChoice {
  /** What the pane sends. Claude takes a name on the command line; codex takes a position in the
   *  picker its own `/model` opens, because that command reads an argument as a message to answer
   *  rather than as a model (measured 2026-09-12: `/model gpt-5.6-sol` was answered, not obeyed). */
  key: string
  /** The CLI's own name for it. Not translated: these are product names. */
  label: string
}

/**
 * What Claude's `/model` takes. Sending one of these switches outright, with no screen in between,
 * except that crossing model families asks first because the conversation is cached for the model it
 * is on — the pane notices that nothing moved and says where the question went.
 *
 * Hand-kept, and it is the one thing here that can go out of date. A model added upstream is missing
 * from this list until someone adds it; one removed answers with the CLI's own error in the terminal.
 * Neither is silent, and typing the name in full still works either way.
 */
export const CLAUDE_MODEL_CHOICES: readonly CliModelChoice[] = [
  { key: 'default', label: 'Default' },
  { key: 'opus', label: 'Opus' },
  { key: 'opus[1m]', label: 'Opus (1M context)' },
  { key: 'sonnet', label: 'Sonnet' },
  { key: 'haiku', label: 'Haiku' },
  { key: 'fable', label: 'Fable' }
]

/**
 * What codex's own picker lists, in its order — the key is the digit that selects that row.
 *
 * Positional, so a list that has gone stale picks the wrong row. That is survivable only because the
 * pane stops there: codex asks for the reasoning level next, on a screen that names the model it is
 * asking about, and the person is looking at it. A wrong row is read and cancelled rather than
 * silently applied, which is why this never answers that second question for them.
 */
export const CODEX_MODEL_CHOICES: readonly CliModelChoice[] = [
  { key: '1', label: 'gpt-6-astra' },
  { key: '2', label: 'gpt-5.6-sol' },
  { key: '3', label: 'gpt-5.6-terra' },
  { key: '4', label: 'gpt-5.6-luna' },
  { key: '5', label: 'gpt-5.5' }
]

/**
 * What Claude's `/effort` takes. Its own screen is a slider rather than a list — `low medium high
 * xhigh max ultracode`, moved with the arrow keys — but the command also takes the name outright, so
 * the pane never has to drive that slider (both measured 2026-09-12: `/effort high` answered "Set
 * effort level to high").
 *
 * It is saved as the default for new sessions, which is what Claude's own screen does on Enter too;
 * the screen's `s` key, which would change this session alone, has no spoken form and stays there.
 *
 * Hand-kept, with the same caveat as CLAUDE_MODEL_CHOICES: a level added upstream is missing until
 * someone adds it, and one removed answers with the CLI's own error where it can be read.
 */
export const CLAUDE_EFFORT_CHOICES: readonly CliModelChoice[] = [
  { key: 'low', label: 'low' },
  { key: 'medium', label: 'medium' },
  { key: 'high', label: 'high' },
  { key: 'xhigh', label: 'xhigh' },
  { key: 'max', label: 'max' },
  { key: 'ultracode', label: 'ultracode' }
]

/**
 * What codex calls its reasoning levels. codex has no `/effort`: `/model` asks two questions in a
 * row, the model first and the reasoning level second, and the level is the second screen's rows.
 *
 * The key is the **name** on that screen, not a digit, and the digit is read off the screen when the
 * screen is up (codexDigitFor in ./codexPicker.ts). So unlike CODEX_MODEL_CHOICES this list going
 * stale cannot press the wrong row — a name that is no longer there presses nothing.
 *
 * codex's fifth row, `More reasoning…`, opens a further screen for Max and Ultra. It is left out
 * deliberately: answering it would need a third screen driven from here, and the menu already offers
 * the terminal for what it does not cover.
 */
export const CODEX_EFFORT_CHOICES: readonly CliModelChoice[] = [
  { key: 'Low', label: 'Low' },
  { key: 'Medium', label: 'Medium' },
  { key: 'High', label: 'High' },
  { key: 'Extra high', label: 'Extra high' }
]
