import { useEffect, useRef, useState } from 'react'
import type { Account, BranchRef, ScheduleConfig, Provider } from '../../../core/types'
import { providerOf } from '../../../core/providers/meta'
import { isSlackReady } from '../../../core/slack/ready'
import { resolveInitialBase } from '../../../core/worktrees/base'
import { toast } from '../lib/toast'
import { useI18n } from '../i18n/I18nProvider'
import { AccountSelect } from './AccountSelect'
import { ScheduleFields } from './ScheduleFields'

const SOFT_LIMIT = 12
const MAX_ROLL_ACCOUNTS = 3

export function NewSessionDialog({
  accounts,
  runningCount,
  initialCwd = null, // prefill from WorktreePanel's 'start session'
  onSpawn,
  onCancel
}: {
  accounts: Account[]
  runningCount: number
  initialCwd?: string | null
  onSpawn: (opts: {
    accountIds: string[]
    cwd: string
    saveDefault: boolean
    roll: boolean
    rollPrompt?: string
    slackNotify: boolean
    bypassPermissions: boolean
    useWorktree: boolean
    worktreeName?: string
    worktreeBaseRef?: string
    repoRoot: string | null
    schedule?: ScheduleConfig
  }) => void | Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [cwd, setCwd] = useState<string | null>(initialCwd)
  // Account slots — [0] is the primary account, slots 1 and 2 are the switch order once the limit is hit
  const [accountIds, setAccountIds] = useState<string[]>([accounts[0]?.id ?? ''])
  const [saveDefault, setSaveDefault] = useState(false)
  const [rollMode, setRollMode] = useState(false) // auto-resume toggle for a single account
  const [rollPrompt, setRollPrompt] = useState('') // text to send on a rolling resume (empty means the default)
  const [slackNotify, setSlackNotify] = useState(false) // Slack progress notifications
  const [bypassPermissions, setBypassPermissions] = useState(false) // start without permission prompts
  const [slackReady, setSlackReady] = useState(false) // whether a webhook URL is configured — the checkbox is disabled when it is not
  // Both CLIs, because either one can be the missing one — the app opens with just one installed
  const [cliOk, setCliOk] = useState({ claude: true, codex: true })
  const [repoRoot, setRepoRoot] = useState<string | null>(null) // result of the git repo check
  const [resolvingRepo, setResolvingRepo] = useState(false) // blocks start while the check runs — stops a spawn with the previous repoRoot
  const [useWorktree, setUseWorktree] = useState(false)
  const [wtName, setWtName] = useState('')
  // Base-branch candidates. null = not loaded yet (or the lookup failed) — the select stays hidden then and
  // creation falls back to the automatic detection, exactly as before this picker existed.
  const [branches, setBranches] = useState<BranchRef[] | null>(null)
  const [wtBaseRef, setWtBaseRef] = useState('')
  // Recurring command scheduler. ScheduleFields assembles the input, this only holds the result
  const [schedOn, setSchedOn] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null)
  // Shows the wait between the start click and the tab opening (splitting off a worktree takes a few
  // seconds: fetch, worktree add, copying the includes). This flag also stops a second click from
  // creating two worktrees.
  const [starting, setStarting] = useState(false)
  const touched = useRef(false)
  // On success App closes this modal (setShowNew(false)), so finally can run after unmount
  const mounted = useRef(true)
  useEffect(() => () => void (mounted.current = false), [])

  useEffect(() => {
    // isSlackReady (core/slack/ready.ts) shares its criteria with SlackNotifier.applyConfig() in
    // src/main/slack.ts — under the old condition that only looked at webhookUrl, a user who had set
    // only botToken + channelId could not tick the checkbox even though the bot path was actually on.
    void window.api.slack.getConfig().then((c) => setSlackReady(isSlackReady(c)))
    void window.api.system.checkCli().then((c) => setCliOk({ claude: c.claude.ok, codex: c.codex.ok }))
  }, [])

  useEffect(() => {
    // Loaded when the checkbox is ticked, not on every modal open — there is no reason to run git until the
    // user actually wants a worktree. A failure leaves branches null, which hides the select and lets
    // createWorktree detect the base as it always has.
    if (!useWorktree || !repoRoot) return
    let cancelled = false
    void window.api.worktrees
      .listBranches(repoRoot)
      .then(({ branches: list, detected }) => {
        if (cancelled) return
        const base = resolveInitialBase({ branches: list, detected })
        if (base === null) {
          // Nothing to fork from (a repo with no commits yet). Refusing here beats letting the start
          // button run: the loading overlay is opaque and covers the Cancel button, and outside-click
          // close is disabled while starting, so a failure mid-flight leaves no way out of the modal.
          toast.error(t('session.new.worktreeNoBase'))
          setUseWorktree(false)
          setBranches(null)
          return
        }
        setBranches(list)
        // Preselect the detected base so leaving this alone behaves as it did before the picker existed
        setWtBaseRef((prev) => prev || base)
      })
      .catch(() => {
        if (!cancelled) setBranches(null)
      })
    return () => {
      cancelled = true
    }
  }, [useWorktree, repoRoot])

  useEffect(() => {
    // git repo check plus the default-account preselect. A worktree session uses the mapping keyed by the original repo too
    if (!cwd) return
    let cancelled = false
    setResolvingRepo(true) // disable the start button until the check finishes so nothing spawns with the previous repoRoot
    void (async () => {
      let root: string | null
      try {
        root = await window.api.worktrees.isGitRepo(cwd)
      } catch {
        // An IPC failure is treated as "not a git repo" as well — it only hides the worktree option, it does not block starting a normal session
        root = null
      } finally {
        if (!cancelled) setResolvingRepo(false)
      }
      if (cancelled) return
      setRepoRoot(root)
      const id = await window.api.projects.getDefaultAccount(root ?? cwd)
      if (cancelled || !id || touched.current || !accounts.some((a) => a.id === id)) return
      setAccountIds((prev) => (prev.includes(id) ? prev : [id, ...prev.slice(1)]))
    })()
    return () => {
      cancelled = true
      setResolvingRepo(false) // the check was discarded — clear it so nothing stays stuck (the new cwd's effect sets it back to true)
    }
  }, [cwd, accounts])

  const pick = async (): Promise<void> => {
    const dir = await window.api.system.pickFolder()
    if (dir) {
      touched.current = false // a new folder means a new preselect context
      setUseWorktree(false) // a new folder may be a different repo, so the previous folder's worktree option and name no longer apply
      setWtName('')
      setCwd(dir)
    }
  }

  // Only the undefined-tolerant wrapper is local to this file, the decision itself is delegated to providerOf
  const provider = (a: Account | undefined): Provider => (a ? providerOf(a) : 'claude')
  const primaryProvider = provider(accounts.find((a) => a.id === accountIds[0]))
  // Whether the CLI this account needs is missing — the only thing that gates starting. Rolling
  // supports codex too (codexRolling.ts) and so do Slack notifications (turn completion is detected
  // from rollout's task_complete), so this flag must not hide either of those.
  const primaryCliMissing = !cliOk[primaryProvider]
  // Per-slot options: this slot's current value plus any account no other slot uses (no duplicates).
  // Rolling slots (1 and 2) only offer accounts with the same provider as the primary account.
  const options = (slot: number): Account[] =>
    accounts.filter(
      (a) =>
        (slot === 0 || provider(a) === primaryProvider) &&
        (a.id === accountIds[slot] || !accountIds.includes(a.id))
    )
  const canAdd =
    accountIds.length < MAX_ROLL_ACCOUNTS &&
    accounts.some((a) => provider(a) === primaryProvider && !accountIds.includes(a.id))
  // Whether rolling is on — with multiple accounts (2+) it is always on (checkbox pinned and disabled), with a single account the user toggles it
  const multi = accountIds.length >= 2
  const rollChecked = multi ? true : rollMode

  const withWorktree = !!repoRoot && useWorktree

  const start = async (): Promise<void> => {
    if (!cwd || starting) return
    setStarting(true)
    try {
      // onSpawn (App.spawn) handles failures internally with a toast and does not reject — both
      // success and failure come back here, and on success App has already closed the modal so the
      // setStarting below is a no-op.
      await onSpawn({
        accountIds,
        cwd,
        saveDefault,
        roll: rollChecked,
        rollPrompt: rollChecked ? rollPrompt.trim() || undefined : undefined,
        slackNotify: slackReady && slackNotify,
        bypassPermissions,
        useWorktree: withWorktree,
        worktreeName: wtName.trim() || undefined,
        worktreeBaseRef: wtBaseRef || undefined,
        repoRoot,
        schedule: schedOn ? (schedule ?? undefined) : undefined
      })
    } finally {
      if (mounted.current) setStarting(false)
    }
  }

  return (
    // While starting, an outside click does not close this — the worktree creation and spawn already
    // under way are not cancelled, so if only the modal disappears the user mistakes it for a cancel
    <div className="modal-backdrop" onClick={() => !starting && onCancel()}>
      <div className="modal new-session" onClick={(e) => e.stopPropagation()}>
        {starting && (
          <div className="loading-overlay">
            <span className="loading-spinner" aria-hidden="true" />
            {t(withWorktree ? 'session.new.startingWorktree' : 'session.new.starting')}
          </div>
        )}
        <h2>{t('session.new.title')}</h2>
        {runningCount >= SOFT_LIMIT && (
          <p className="warn">{t('session.new.runningWarning', { count: runningCount })}</p>
        )}
        {primaryCliMissing && (
          <p className="warn">
            {t(
              primaryProvider === 'codex'
                ? 'session.new.codexMissingPre'
                : 'session.new.claudeMissingPre'
            )}{' '}
            <code>
              {primaryProvider === 'codex'
                ? 'npm install -g @openai/codex'
                : 'npm install -g @anthropic-ai/claude-code'}
            </code>{' '}
            {t('session.new.cliMissingPost')}
          </p>
        )}
        <div className="field">
          <label>{t('session.field.projectFolder')}</label>
          <div className="row">
            <span className="path">{cwd ?? t('session.new.folderNotSelected')}</span>
            <button onClick={() => void pick()}>{t('session.new.pickFolder')}</button>
          </div>
        </div>
        {repoRoot && (
          <>
            <label className="row check-small">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => setUseWorktree(e.target.checked)}
              />
              {t('session.new.useWorktree')}
            </label>
            {useWorktree && (
              <div className="field">
                <input
                  type="text"
                  value={wtName}
                  maxLength={80}
                  placeholder={t('session.new.worktreeNamePlaceholder')}
                  onChange={(e) => setWtName(e.target.value)}
                />
                {branches && branches.length > 0 && (
                  <label className="worktree-base-row">
                    <span>{t('session.new.worktreeBaseRef')}</span>
                    <select
                      className="settings-lang-select"
                      value={wtBaseRef}
                      onChange={(e) => setWtBaseRef(e.target.value)}
                    >
                      {/* Current branch first — branching off what you are on is the common case, and the
                          automatic detection could never express it (it only probes origin/*, main, master) */}
                      {branches
                        .filter((b) => b.current)
                        .map((b) => (
                          <option key={`cur-${b.name}`} value={b.name}>
                            {b.name} {t('session.new.worktreeBaseCurrent')}
                          </option>
                        ))}
                      <optgroup label={t('session.new.worktreeBaseRemote')}>
                        {branches
                          .filter((b) => b.remote)
                          .map((b) => (
                            <option key={`r-${b.name}`} value={b.name}>
                              {b.name}
                            </option>
                          ))}
                      </optgroup>
                      <optgroup label={t('session.new.worktreeBaseLocal')}>
                        {branches
                          .filter((b) => !b.remote && !b.current)
                          .map((b) => (
                            <option key={`l-${b.name}`} value={b.name}>
                              {b.name}
                            </option>
                          ))}
                      </optgroup>
                    </select>
                  </label>
                )}
              </div>
            )}
          </>
        )}
        <div className="field">
          <label>{t('session.field.account')}</label>
          {accountIds.map((id, slot) => (
            <div className="account-slot" key={slot}>
              <span className="slot-label">
                {slot === 0
                  ? t('session.new.accountSlotPrimary')
                  : t('session.new.accountSlotRoll', { slot: slot + 1 })}
              </span>
              <AccountSelect
                accounts={options(slot)}
                value={id}
                onChange={(v) => {
                  if (slot === 0) touched.current = true
                  // Changing the primary account's provider collapses the rolling slots — a mixed chain cannot be built
                  const nextProvider = provider(accounts.find((a) => a.id === v))
                  setAccountIds((prev) =>
                    slot === 0 && nextProvider !== primaryProvider
                      ? [v]
                      : prev.map((p, i) => (i === slot ? v : p))
                  )
                }}
              />
              {slot > 0 && (
                <button
                  className="slot-remove"
                  aria-label={t('session.new.removeAccountSlot')}
                  title={t('session.new.removeAccountSlot')}
                  onClick={() => setAccountIds((prev) => prev.filter((_, i) => i !== slot))}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {canAdd && (
            <button
              className="add-account"
              onClick={() =>
                setAccountIds((prev) => {
                  const next = accounts.find(
                    (a) => provider(a) === primaryProvider && !prev.includes(a.id)
                  )
                  return next ? [...prev, next.id] : prev
                })
              }
            >
              {t('session.new.addAccountSlot')}
            </button>
          )}
        </div>
        <label className="row check-small">
          <input
            type="checkbox"
            checked={rollChecked}
            disabled={multi}
            onChange={(e) => setRollMode(e.target.checked)}
          />
          {t('session.new.rollLabel')}
          {multi && <span className="check-note">{t('session.new.multiAccountAuto')}</span>}
        </label>
        {rollChecked && (
          <div className="field roll-prompt-field">
            {/* Keep the placeholder in sync with the actual default rolling.ts and codexRolling.ts send
                (the rolling.continuePrompt key) — that key follows the app language too, so in both ko
                and en, session.new.rollPromptPlaceholder and rolling.continuePrompt must hold the same value. */}
            <input
              type="text"
              className="roll-prompt-input"
              value={rollPrompt}
              maxLength={500}
              placeholder={t('session.new.rollPromptPlaceholder')}
              onChange={(e) => setRollPrompt(e.target.value)}
            />
            <span className="roll-prompt-hint">{t('session.new.rollPromptHint')}</span>
          </div>
        )}
        <label className="row check-small">
          <input type="checkbox" checked={schedOn} onChange={(e) => setSchedOn(e.target.checked)} />
          {t('session.new.schedLabel')}
        </label>
        {/* initial={schedule} restores the previous input when this is toggled off and back on —
            ScheduleFields loses its internal state on unmount, so the parent holds the last value that
            was valid (schedule) and feeds it back in. An intermediate input state with an empty command
            is not restored, because onChange emits null for it so it never reaches schedule — not a
            complete fix, but it covers the common case (toggling the checkbox). */}
        {schedOn && <ScheduleFields initial={schedule} onChange={setSchedule} />}
        {/* Slack notifications work for every provider — claude detects turn completion through the
            statusLine hook, codex through rollout's task_complete */}
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
          <input type="checkbox" checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} />
          {t('session.new.saveDefaultAccount')}
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
          <button onClick={onCancel} disabled={starting}>
            {t('common.cancel')}
          </button>
          <button
            className="primary"
            disabled={
              !cwd ||
              starting ||
              resolvingRepo ||
              accountIds.some((id) => !id) ||
              primaryCliMissing ||
              (schedOn && !schedule)
            }
            onClick={() => void start()}
          >
            {t('session.new.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
