// Whether a session's terminal can be handed a batch of annotations right now.
//
// A design batch is delivered as a paste followed by Enter, and both are wrong when the agent is not
// at its prompt. Twice in one afternoon a batch went into a session still showing its folder-trust
// dialog: the text was swallowed by the dialog's own input handling and the Enter answered a
// question nobody read. The batch was gone with no sign it had ever been sent.
//
// `looksLikeChoicePrompt` already answers this for Claude Code — the rolling carry-on prompt asks the
// same question before typing blind, for the same reason. This adds what it does not cover: Codex
// draws its cursor with a different glyph, and its dialogs close with a different line.
// node: no imports beyond core — the renderer imports this file.
import { looksLikeChoicePrompt, stripAnsi } from '../../rolling/detect'

/** A cursor sitting on a numbered item, drawn the way Codex draws it. `looksLikeChoicePrompt` accepts
 *  `❯` and `>`; Codex uses U+203A, so its "Do you trust the contents of this directory? › 1. Yes,
 *  continue" went straight past. */
const CODEX_CHOICE_CURSOR_RE = /^[^\S\n]*›[^\S\n]*\d+[ \t]*[.)][ \t]*\S/m

/** Is a dialog waiting for an answer on this screen?
 *
 *  Biased towards saying yes. A refused send costs one click — the user answers the dialog and sends
 *  again — where a send into a dialog costs the whole batch and answers a prompt at random. That is
 *  the same trade `looksLikeChoicePrompt` already makes: knowing *what* is waiting is not needed. */
export function isWaitingOnDialog(screen: string): boolean {
  if (looksLikeChoicePrompt(screen)) return true
  return CODEX_CHOICE_CURSOR_RE.test(stripAnsi(screen))
}

/** How long to wait between the paste and the Enter. The paste has to be through the terminal and
 *  into the agent's input box before the Enter lands, or the Enter submits an empty prompt. */
export const POST_PASTE_SUBMIT_DELAY_MS = 50
