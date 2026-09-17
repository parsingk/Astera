import { useEffect, useState } from 'react'
import type { Account, HistoryEntry, RollConfig, ScheduleConfig, SessionKind } from '../../../core/types'
import { resumeAccountOptions, resumeChatAllowed, resumeRollAccountIds } from '../../../core/resume'
import { isSlackReady } from '../../../core/slack/ready'
import { useI18n } from '../i18n/I18nProvider'
import { useChatAvailability } from '../hooks/useChatAvailability'
import { isGhostAccountId } from '../../../core/accounts/ghostId'
import { AccountSelect } from './AccountSelect'
import { ScheduleFields } from './ScheduleFields'

/** Modal for resuming a session from history. Only logged-in accounts appear as candidates and the
 *  original account is preselected. Picking a different account makes ipc copy the transcript into that
 *  account's configDir before --resume — since slice 4c both 터미널 and 대화 resume this way, so either
 *  kind can run on any candidate the picker offers (resumeChatAllowed).
 *
 *  The rolling, scheduler, Slack and permission checkboxes are settled here. ipc.ts used to quietly
 *  revive the saved rolling and schedule settings (with no way to turn them off) and there was no way
 *  at all to enable Slack. Now the saved values are only the checkbox initial values, and what goes to
 *  spawn is what the user settled on. */
export function ResumeDialog({
  entry,
  cwd,
  accounts,
  ghostAccounts,
  defaultSessionKind,
  onConfirm,
  onCancel
}: {
  entry: HistoryEntry
  cwd: string
  accounts: Account[]
  /** Unregistered sources. Used only to identify the entry's owner — a ghost can never be a candidate,
   *  because resuming needs an account that can authenticate. */
  ghostAccounts: Account[]
  /** Which kind the dialog opens on (the Settings default). Seeds the selection below and nothing
   *  more — picking the other one here belongs to this session and is not written back. */
  defaultSessionKind: SessionKind
  onConfirm: (opts: {
    accountIds: string[] // [0] = the account to continue on, with the chain after it when rolling is on
    kind: SessionKind
    roll: boolean
    rollPrompt?: string
    slackNotify: boolean
    bypassPermissions: boolean
    schedule?: ScheduleConfig
  }) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [options, setOptions] = useState<Account[] | null>(null) // null = login status still being checked
  const [selectedId, setSelectedId] = useState<string>('')
  // Session kind — terminal (pty) or chat (a Host-owned line process resumed by its protocol thread
  // id — since slice 4c the transcript is copied into the chosen account first, same as terminal, so
  // either kind can land on any candidate the picker offers). Same seeded-and-falls-back rule as
  // NewSessionDialog.
  const [kind, setKind] = useState<SessionKind>(defaultSessionKind)
  // The saved settings — the source of the checkbox initial values and the input to the roll chain calculation
  const [savedRoll, setSavedRoll] = useState<RollConfig | null>(null)
  const [rollOn, setRollOn] = useState(false)
  const [rollPrompt, setRollPrompt] = useState('')
  const [savedSchedule, setSavedSchedule] = useState<ScheduleConfig | null>(null)
  const [schedOn, setSchedOn] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null)
  const [slackNotify, setSlackNotify] = useState(false)
  const [slackReady, setSlackReady] = useState(false)
  const [bypassPermissions, setBypassPermissions] = useState(false)
  const [loadedDefaults, setLoadedDefaults] = useState(false) // mount ScheduleFields only after the prefill

  // The entry's owner, registered or not. undefined means not even detection knows the directory any
  // more (an old entry whose folder is gone) — resume still works on another account.
  const owner = accounts.find((a) => a.id === entry.accountId) ?? ghostAccounts.find((a) => a.id === entry.accountId)
  const ownerGone = owner === undefined || isGhostAccountId(owner.id)

  useEffect(() => {
    let cancelled = false
    // Candidates are only logged-in accounts with the same provider as the original account —
    // resumeAccountOptions does the filtering. Cross-account between codex accounts is supported too,
    // by copying the rollout (the same mechanism as claude, with ipc branching on the path mapping).
    void Promise.all(
      accounts.map(async (a) => [a.id, await window.api.accounts.loginStatus(a.id)] as const)
    ).then((pairs) => {
      if (cancelled) return
      const loggedIn = new Set(pairs.filter(([, ok]) => ok).map(([id]) => id))
      // The owner goes in as an object: an unregistered owner is not in `accounts`, so looking it up by id
      // would fail and the provider would fall back to claude — offering claude accounts for a codex
      // transcript. Only registered accounts are passed as candidates.
      const opts = resumeAccountOptions(accounts, loggedIn, owner)
      setOptions(opts)
      setSelectedId(opts[0]?.id ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [accounts, entry.accountId])

  useEffect(() => {
    // The saved rolling and schedule settings become the checkbox initial values. A failed lookup is
    // swallowed — the modal still opens with everything defaulted off. Slack readiness is decided by
    // isSlackReady (looking only at webhookUrl means a user who configured just the bot path cannot
    // turn it on).
    let cancelled = false
    void window.api.slack.getConfig().then((c) => {
      if (!cancelled) setSlackReady(isSlackReady(c))
    })
    void window.api.sessions
      .resumeDefaults(entry.sessionId)
      .then((d) => {
        if (cancelled) return
        setSavedRoll(d.roll)
        setRollOn(d.roll !== null)
        setRollPrompt(d.roll?.prompt ?? '')
        setSavedSchedule(d.schedule)
        setSchedOn(d.schedule !== null)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadedDefaults(true)
      })
    return () => {
      cancelled = true
    }
  }, [entry.sessionId])

  const crossAccount = selectedId !== '' && selectedId !== entry.accountId
  // The chain that actually goes to spawn — the display uses this value too (the result after the provider filter and the rotation reorder)
  const rollChain = selectedId ? resumeRollAccountIds(savedRoll?.accountIds ?? null, accounts, selectedId) : []
  const labelOf = (id: string): string => accounts.find((a) => a.id === id)?.label ?? id

  // The Host poll is shared with NewSessionDialog; either provider's account can open a chat session.
  const { enabled: chatEnabled, checking: chatChecking } = useChatAvailability()
  // Resuming one is no narrower than starting one any more (resumeChatAllowed) — the chat spawn path
  // copies the transcript into the chosen account too, so any candidate the picker offers works.
  const chatAllowed = resumeChatAllowed({ chatEnabled, selectedId })
  // A remembered 대화 falls back to 터미널 while it is unavailable — never persisted, so it is offered
  // again once the condition clears (same reasoning as NewSessionDialog's own fallback effect). Picking
  // another account is one of those conditions: the choice comes back the moment the owner is picked
  // again, which is why the fallback is state here and never written back to the setting.
  // Two things here are unknown for the first moment rather than false: whether the Host can run 대화
  // at all (chatChecking), and which account this resumes on — `options` is null until the login probe
  // answers, and `selectedId` is '' until then, which alone makes chatAllowed false. Acting on either
  // before it is known threw the seeded 대화 selection away and never put it back. Same defect as
  // NewSessionDialog's, with one more source of "not yet".
  useEffect(() => {
    if (kind === 'chat' && !chatAllowed && !chatChecking && options !== null) setKind('terminal')
  }, [kind, chatAllowed, chatChecking, options])

  const confirm = (): void => {
    if (!selectedId) return
    onConfirm({
      accountIds: rollOn ? rollChain : [selectedId],
      kind,
      roll: rollOn,
      rollPrompt: rollOn ? rollPrompt.trim() || undefined : undefined,
      slackNotify: slackReady && slackNotify,
      bypassPermissions,
      schedule: schedOn ? (schedule ?? undefined) : undefined
    })
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal resume" onClick={(e) => e.stopPropagation()}>
        <h2>{t('session.resume.title')}</h2>
        {/* Heads the form as its own ruled-off section, as in NewSessionDialog: the way the resumed
            session runs is decided before the conversation, folder and account it applies to. */}
        <div className="field kind-field">
          <label>{t('session.new.kindLabel')}</label>
          <div className="kind-segmented">
            <button
              type="button"
              className={`segmented${kind === 'terminal' ? ' active' : ''}`}
              onClick={() => {
                setKind('terminal')
              }}
            >
              {t('session.kind.terminal')}
            </button>
            <button
              type="button"
              className={`segmented${kind === 'chat' ? ' active' : ''}`}
              disabled={!chatAllowed}
              onClick={() => {
                setKind('chat')
              }}
            >
              {t('session.kind.chat')}
            </button>
          </div>
          {!chatEnabled && !chatChecking && (
            <span className="kind-note">{t('session.new.kindHostOld')}</span>
          )}
          {chatAllowed && kind === 'chat' && (
            <span className="kind-note">{t('session.new.kindChatHint')}</span>
          )}
        </div>
        <div className="field">
          <label>{t('session.resume.conversationLabel')}</label>
          <span className="path">{entry.title}</span>
        </div>
        <div className="field">
          <label>{t('session.field.projectFolder')}</label>
          <span className="path">{cwd}</span>
        </div>
        {/* Only when the owning account is gone. With it alive the picker already preselects it and puts
            the '(original account)' suffix on it, so a second row would just repeat that. */}
        {ownerGone && (
          <div className="field">
            <label>{t('session.resume.originAccount')}</label>
            <span className="path">
              {owner?.label ?? entry.accountId}
              <em className="origin-deleted">{t('session.resume.originDeleted')}</em>
            </span>
          </div>
        )}
        <div className="field">
          <label>{t('session.field.account')}</label>
          {options === null ? (
            <span className="check-note">{t('session.resume.checkingLogin')}</span>
          ) : options.length === 0 ? (
            <span className="warn">{t('session.resume.noLoggedInAccounts')}</span>
          ) : (
            <AccountSelect
              accounts={options}
              value={selectedId}
              onChange={setSelectedId}
              suffixOf={(a) => (a.id === entry.accountId ? t('session.resume.originalAccountSuffix') : null)}
            />
          )}
          {crossAccount && (
            <span className="roll-prompt-hint">{t('session.resume.crossAccountHint')}</span>
          )}
        </div>
        {/* Rolling now applies to 대화 too (slice 4c) — see NewSessionDialog's own note. */}
        <label className="row check-small">
          <input type="checkbox" checked={rollOn} onChange={(e) => setRollOn(e.target.checked)} />
          {t('session.new.rollLabel')}
        </label>
        {rollOn && (
          <div className="field roll-prompt-field">
            <input
              type="text"
              className="roll-prompt-input"
              value={rollPrompt}
              maxLength={500}
              placeholder={t('session.new.rollPromptPlaceholder')}
              onChange={(e) => setRollPrompt(e.target.value)}
            />
            <span className="roll-prompt-hint">{t('session.new.rollPromptHint')}</span>
            {rollChain.length >= 2 && (
              <span className="roll-prompt-hint">
                {t('session.resume.rollChainHint', { chain: rollChain.map(labelOf).join(' → ') })}
              </span>
            )}
          </div>
        )}
        {/* The label follows the field below it — see NewSessionDialog's own note. */}
        <label className="row check-small">
          <input type="checkbox" checked={schedOn} onChange={(e) => setSchedOn(e.target.checked)} />
          {t(kind === 'chat' ? 'session.new.schedLabelChat' : 'session.new.schedLabel')}
        </label>
        {/* Mounted only after the saved-value lookup finishes — ScheduleFields reads initial exactly
            once, at mount. schedule ?? savedSchedule: on a toggle off and back on, a value the user
            already edited (schedule) is restored first, and before any edit it is filled from the saved
            value (savedSchedule). schedule only ever holds the last value that was valid (an
            intermediate state with an empty command sends null from onChange and is not recorded), so
            that limitation carries over here as well. */}
        {schedOn && loadedDefaults && (
          <ScheduleFields initial={schedule ?? savedSchedule} onChange={setSchedule} chat={kind === 'chat'} />
        )}
        <label className="row check-small">
          <input
            type="checkbox"
            checked={slackReady && slackNotify}
            disabled={!slackReady}
            onChange={(e) => setSlackNotify(e.target.checked)}
          />
          {t('session.new.slackNotify')}
          {!slackReady && <span className="check-note">{t('session.new.slackNeedsWebhook')}</span>}
        </label>
        <label className="row check-small">
          <input
            type="checkbox"
            checked={bypassPermissions}
            onChange={(e) => setBypassPermissions(e.target.checked)}
          />
          {t('session.new.bypassPermissions')}
        </label>
        <div className="row right">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={!selectedId || (schedOn && !schedule)}
            onClick={confirm}
          >
            {t('session.resume.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
