// The answer form of a Task's open question in the run's graph (RunDetail): the question, its choices and a box for an
// answer in words. A check that could not be made (plugin Phase 5 C9) takes one of its three choices and nothing else,
// so each is shown in this app's words with what it does, and there is no box: gate-resolve refuses any other answer.
import { X } from 'lucide-react'
import type { JobTask } from '../../../core/types'
import { isGitHubGateKind } from '../../../core/orchestration/types'
import { useI18n } from '../i18n/I18nProvider'
import type { Translate } from './checkText'

type Gate = NonNullable<JobTask['gate']>
export interface GateChoice {
  /** What gate-resolve is sent: the option itself, never its label */
  value: string
  label: string
  hint?: string
}

/** A check-unavailable question's options in words (C9): its label and the line that says what it does. */
const CHECK_UNAVAILABLE_WORDS = {
  retry: ['jobs.gate.checkUnavailable.retry', 'jobs.gate.checkUnavailable.retryHint'],
  'skip-check': ['jobs.gate.checkUnavailable.skip', 'jobs.gate.checkUnavailable.skipHint'],
  'mark-failed': ['jobs.gate.checkUnavailable.fail', 'jobs.gate.checkUnavailable.failHint']
} as const
/** An exhausted repair budget's options in words (convergence design §5.2): words the catalogs held and no screen used */
const EXHAUSTED_WORDS = {
  'retry-once': 'jobs.convergence.gate.retryOnce',
  'mark-failed': 'jobs.convergence.gate.markFailed'
} as const

/** A GitHub question's answers in words (GitHub lifecycle G3b2): its label and the line that says what it does. */
const GITHUB_WORDS = {
  wait: ['jobs.gate.github.wait', 'jobs.gate.github.waitHint'],
  'no-ci': ['jobs.gate.github.noCi', 'jobs.gate.github.noCiHint'],
  continue: ['jobs.gate.github.continue', 'jobs.gate.github.continueHint'],
  retry: ['jobs.gate.github.retry', 'jobs.gate.github.retryHint'],
  'mark-failed': ['jobs.gate.github.markFailed', 'jobs.gate.github.markFailedHint']
} as const

/** The choices a question offers, in words, and whether it takes an answer in words too. An option this app does not
 *  know is offered as it is. */
export function gateChoicesOf(gate: Gate, t: Translate): { choices: GateChoice[]; freeText: boolean } {
  const options = gate.options ?? []
  if (gate.kind === 'check-unavailable')
    return {
      choices: options.map((o) => {
        if (!Object.hasOwn(CHECK_UNAVAILABLE_WORDS, o)) return { value: o, label: o }
        const [label, hint] = CHECK_UNAVAILABLE_WORDS[o as keyof typeof CHECK_UNAVAILABLE_WORDS]
        return { value: o, label: t(label), hint: t(hint) }
      }),
      freeText: false
    }
  // A GitHub question takes the answers it lists and no other (gate-resolve), so there is no box
  if (isGitHubGateKind(gate.kind))
    return {
      choices: options.map((o) => {
        const pr = /^pr-(\d+)$/.exec(o)
        if (pr) return { value: o, label: t('jobs.gate.github.bindPr', { number: Number(pr[1]) }), hint: t('jobs.gate.github.bindPrHint') }
        if (!Object.hasOwn(GITHUB_WORDS, o)) return { value: o, label: o }
        const [label, hint] = GITHUB_WORDS[o as keyof typeof GITHUB_WORDS]
        return { value: o, label: t(label), hint: t(hint) }
      }),
      freeText: false
    }
  if (gate.kind === 'convergence-exhausted')
    return {
      choices: options.map((o) => ({ value: o, label: Object.hasOwn(EXHAUSTED_WORDS, o) ? t(EXHAUSTED_WORDS[o as keyof typeof EXHAUSTED_WORDS]) : o })),
      freeText: true
    }
  return { choices: options.map((o) => ({ value: o, label: o })), freeText: true }
}

export function GateAnswer({
  gate,
  answer,
  busy,
  error,
  onAnswer,
  onResolve,
  onCancel
}: {
  gate: Gate
  /** The answer in words being written */
  answer: string
  /** An answer is on its way: the buttons wait */
  busy: boolean
  error: string | null
  onAnswer(text: string): void
  /** Answers the question: a choice's value, or the answer in words */
  onResolve(resolution: string): void
  onCancel(): void
}): React.JSX.Element {
  const { t } = useI18n()
  const { choices, freeText } = gateChoicesOf(gate, t)
  return (
    <>
      <div className="detail-filter">
        <b>{t('jobs.node.answer')}</b>
        <button className="detail-clear" title={t('common.cancel')} aria-label={t('common.cancel')} onClick={onCancel}>
          <X size={12} />
        </button>
      </div>
      <div className="detail-task-fields">
        {/* 질문을 그대로 보여 준다 — 답하는 사람이 그래프의 Gate 줄을 기억하고 있을
            이유가 없다. 읽는 글이라 modal-hint 가 아니라 본문 톤이다 */}
        <p className="detail-gate-question">{gate.question}</p>
        {/* 코디네이터가 고를 것을 줬으면 그것이 답이다 — 자유 입력으로 그 낱말을 다시
            치게 하지 않는다. 버튼은 라벨이 아니라 그 선택지를 resolution 으로 보낸다 */}
        {choices.length > 0 && (
          <div className="detail-gate-options">
            {/* With no box to focus, the first choice takes the focus the Unlock button had: it left with the form's opening */}
            {choices.map((c, i) => (
              <button key={c.value} autoFocus={!freeText && i === 0} disabled={busy} onClick={() => onResolve(c.value)}>
                {c.label}
                {c.hint !== undefined && <span className="detail-gate-option-hint">{c.hint}</span>}
              </button>
            ))}
          </div>
        )}
        {freeText && (
          <div className="field">
            <label>{t('jobs.node.answerLabel')}</label>
            <textarea rows={3} value={answer} onChange={(e) => onAnswer(e.target.value)} autoFocus />
          </div>
        )}
        {error && <p className="warn">{error}</p>}
      </div>
      <div className="row right">
        <button onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        {freeText && (
          <button className="primary" disabled={busy || !answer.trim()} onClick={() => onResolve(answer)}>
            {t('jobs.node.answer')}
          </button>
        )}
      </div>
    </>
  )
}
