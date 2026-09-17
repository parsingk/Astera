// What Slack shows for a chat session's open card, and how a thread reply becomes its answer — pure,
// built from the ChatRequest the adapter already holds (chat-sessions slice 4 design §7.2, §7.3). The
// terminal path reads the same facts out of hook captures and the transcript (transcript.ts); a chat
// session has them first-hand, so nothing here reads a file.
import type { ChatRequest, ApprovalDecision } from '../chat/types'
import type { AskForm, Answer } from '../prompts/askUserQuestion'
import { t, type Lang, type Message } from '../i18n'

export type QuestionAnswerResult = { ok: true; answers: Answer[] } | { ok: false; reason: Message }

const ACCEPT_WORDS = new Set(['허용', 'accept', 'yes', 'y', 'ok', 'approve', 'allow'])
const ALWAYS_WORDS = new Set(['항상 허용', '항상허용', 'always', 'acceptforsession', 'allow always', 'always allow'])
const DECLINE_WORDS = new Set(['거절', 'decline', 'no', 'n', 'deny', 'reject'])

/** The input-needed body for an open chat request — the card's own content, no transcript. */
export function describeChatRequest(request: ChatRequest, lang: Lang): string {
  if (request.kind === 'question') {
    const qs = request.form.questions
    const blocks = qs.map((q) => {
      const head = q.header ? `❓ ${q.header} — ${q.question}` : `❓ ${q.question}`
      const lines = q.options.map((o, i) => (o.description ? `${i + 1}. ${o.label} — ${o.description}` : `${i + 1}. ${o.label}`))
      return [head, ...lines].join('\n')
    })
    // The same two hints transcript.ts's replyHint attaches for a terminal session's AskUserQuestion,
    // so one wording teaches the reply format for both kinds.
    const hint = qs.length > 1 ? t(lang, 'slack.choice.hintPerQuestion') : qs.some((q) => q.multiSelect) ? t(lang, 'slack.choice.hintMulti') : ''
    const body = blocks.join('\n\n')
    return hint === '' ? body : `${body}\n${hint}`
  }
  const hint = request.decisions.includes('acceptForSession') ? t(lang, 'slack.approval.hintAlways') : t(lang, 'slack.approval.hint')
  return [`🔧 ${request.about.tool}`, ...request.about.lines, hint].join('\n')
}

/** A thread reply → the card's answers. Questions separated by `/`, picks by `,`; a part with no number is that question's free text. */
export function questionAnswerOf(text: string, form: AskForm): QuestionAnswerResult {
  const parts = text.split('/').map((s) => s.trim()).filter((s) => s !== '')
  const expected = form.questions.length
  if (parts.length !== expected) return { ok: false, reason: { key: 'slack.choice.countMismatch', params: { expected, got: parts.length } } }
  const answers: Answer[] = []
  for (let i = 0; i < expected; i++) {
    const q = form.questions[i]
    const nums = parts[i].match(/[0-9]+/g) ?? []
    const at = expected > 1 ? { index: i + 1 } : null
    if (nums.length === 0) {
      answers.push({ picks: [], other: parts[i] }) // prose, not a number: the card's free-text row
      continue
    }
    if (!q.multiSelect && nums.length > 1)
      return { ok: false, reason: at ? { key: 'slack.choice.singleOnlyAt', params: at } : { key: 'slack.choice.singleOnly' } }
    const picks: number[] = []
    for (const raw of nums) {
      const n = Number(raw)
      if (n < 1 || n > q.options.length)
        return { ok: false, reason: at ? { key: 'slack.choice.outOfRangeAt', params: { ...at, n: raw, max: q.options.length } } : { key: 'slack.choice.outOfRange', params: { n: raw, max: q.options.length } } }
      if (!picks.includes(n - 1)) picks.push(n - 1)
    }
    answers.push({ picks, other: '' })
  }
  return { ok: true, answers }
}

/** A thread reply → an approval decision, or null when the words are not understood or the decision is not offered. */
export function approvalDecisionOf(text: string, decisions: ReadonlyArray<ApprovalDecision>): ApprovalDecision | null {
  const word = text.trim().toLowerCase().replace(/[.!]+$/, '')
  if (ALWAYS_WORDS.has(word)) return decisions.includes('acceptForSession') ? 'acceptForSession' : null
  if (ACCEPT_WORDS.has(word)) return decisions.includes('accept') ? 'accept' : null
  if (DECLINE_WORDS.has(word)) return decisions.includes('decline') ? 'decline' : null
  return null
}
