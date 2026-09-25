import { useEffect, useRef, useState } from 'react'
import type { Account, BranchRef, ScheduleConfig, SessionKind, Provider } from '../../../core/types'
import type { UnattendedPermission } from '../../../core/chat/types'
import { providerOf } from '../../../core/providers/meta'
import { rollChainCandidates } from '../../../core/resume'
import { isSlackReady } from '../../../core/slack/ready'
import { useChatAvailability } from '../hooks/useChatAvailability'
import { useAccountStatus } from '../hooks/useAccountStatus'
import { orderBranchesForPicker, reconcileBaseRef } from '../../../core/worktrees/base'
import { isWaitingReason, startBlockedBy, type StartBlocked } from '../../../core/sessions/startBlocked'
import type { MessageKey } from '../../../core/i18n'
import { toast } from '../lib/toast'
import { useI18n } from '../i18n/I18nProvider'
import { AccountSelect } from './AccountSelect'
import { BranchGlyph } from './BranchGlyph'
import { Select, type SelectOption } from './Select'
import { ScheduleFields } from './ScheduleFields'
import { X } from 'lucide-react'

const SOFT_LIMIT = 12
const MAX_ROLL_ACCOUNTS = 3
// The full product names the two neighbouring warnings already use (codexMissingPre/claudeMissingPre)
// — cliFailsHere/cliFailsHereUnknown fill their own {cli} placeholder with this instead of the raw
// provider id, so all three lines name the tool the same way.
const CLI_LABEL: Record<Provider, string> = { claude: 'Claude Code CLI', codex: 'Codex CLI' }

export function NewSessionDialog({
  accounts,
  runningCount,
  initialCwd = null, // prefill from WorktreePanel's 'start session'
  onSpawn,
  onCancel,
  defaultSessionKind
}: {
  accounts: Account[]
  runningCount: number
  initialCwd?: string | null
  /** Which kind the dialog opens on (the Settings default). Seeds the selection below and nothing
   *  more — picking the other one here belongs to this session and is not written back. */
  defaultSessionKind: SessionKind
  onSpawn: (opts: {
    accountIds: string[]
    cwd: string
    saveDefault: boolean
    kind: SessionKind
    roll: boolean
    rollPrompt?: string
    slackNotify: boolean
    bypassPermissions: boolean
    /** chat takeover P8: the new chat session's unattended-permission policy. Absent for a terminal
     *  session, which has no such policy at all. */
    unattendedPermission?: UnattendedPermission
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
  // Session kind — terminal (pty) or chat (a Host-owned line process, no terminal at all). Seeded
  // from the Settings default and forced back to 'terminal' below whenever chat is not available, so
  // the toggle never sticks on a choice the person cannot actually start. Changing it here is this
  // session's business — it is not written back to the setting.
  const [kind, setKind] = useState<SessionKind>(defaultSessionKind)
  const [rollMode, setRollMode] = useState(false) // auto-resume toggle for a single account
  const [rollPrompt, setRollPrompt] = useState('') // text to send on a rolling resume (empty means the default)
  const [slackNotify, setSlackNotify] = useState(false) // Slack progress notifications
  // **전역 권한 모드가 이 칸의 기본값이다**(AgentPermissionMode, 기본 'yolo'). 초기값을 true 로 두는
  // 것은 아래 fetch 가 돌아오기 전의 한 프레임을 위해서다 — false 로 시작하면 기본이 켜짐인 설정에서
  // 체크박스가 꺼진 채 잠깐 보였다가 켜진다. 사람이 이 모달에서 끄면 그 세션에만 적용되고 전역
  // 설정은 그대로다: 이 체크박스는 언제나 "이번 세션"을 말한다.
  const [bypassPermissions, setBypassPermissions] = useState(true) // start without permission prompts
  // chat takeover P8: the new chat session's policy for a permission prompt nobody answers while a
  // Host holds it as the writer. Meaningless once bypassPermissions is on — that session never holds a
  // prompt at all — so the control offering this is hidden then (see the checkbox below).
  const [unattended, setUnattended] = useState<UnattendedPermission>('hold')
  const [slackReady, setSlackReady] = useState(false) // whether a webhook URL is configured — the checkbox is disabled when it is not
  // Both CLIs, because either one can be the missing one — the app opens with just one installed.
  // Two different questions live here, asked two different ways (design D3, fix round 2):
  // cliInstalled is cwd-independent ("is it on this machine at all", asked once on mount below) and
  // cliOk is per-folder ("does it run here", re-asked on every cwd change further down) — conflating
  // them into one `--version` call was round 1's mistake: a shell that cannot find a binary writes its
  // own "not recognized"/"not found" to stderr, which reads exactly like the binary itself refusing to
  // run once it exists, so a genuinely missing CLI took the wrong branch and hid the install prompt.
  const [cliInstalled, setCliInstalled] = useState({ claude: true, codex: true })
  const [cliOk, setCliOk] = useState({ claude: true, codex: true })
  // stderr's first line per CLI, from the same per-folder check as cliOk — undefined until a check
  // has actually failed with something to say (a passing check, one that hasn't run yet for this
  // folder, or one that died silently inside its own timeout all leave nothing to show)
  const [cliError, setCliError] = useState<{ claude?: string; codex?: string }>({})
  const [repoRoot, setRepoRoot] = useState<string | null>(null) // result of the git repo check
  const [resolvingRepo, setResolvingRepo] = useState(false) // blocks start while the check runs — stops a spawn with the previous repoRoot
  const [useWorktree, setUseWorktree] = useState(false)
  const [wtName, setWtName] = useState('')
  // Base-branch candidates. null = not loaded yet (or the lookup failed) — the select stays hidden then and
  // creation falls back to the automatic detection, exactly as before this picker existed.
  const [branches, setBranches] = useState<BranchRef[] | null>(null)
  const [wtBaseRef, setWtBaseRef] = useState('')
  // The effect below reads the current pick but must not re-run when it changes, or picking a branch would
  // immediately refetch the list. Same ref-mirror idiom as HistoryBrowser's accountFilterRef.
  const wtBaseRefRef = useRef('')
  wtBaseRefRef.current = wtBaseRef
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
    // src/core/slack/notifier.ts — under the old condition that only looked at webhookUrl, a user who had set
    // only botToken + channelId could not tick the checkbox even though the bot path was actually on.
    void window.api.slack.getConfig().then((c) => setSlackReady(isSlackReady(c)))
    void window.api.settings
      .getAgentPermissionMode()
      .then((m) => setBypassPermissions(m === 'yolo'))
    // Existence, not runnability — asked once here because it does not depend on which folder gets
    // picked (design D3, fix round 2). The per-folder question below has its own effect on [cwd].
    void window.api.system.checkCliInstalled().then(setCliInstalled)
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
        // Reconcile rather than overwrite: the pick survives toggling the checkbox, but a pick left over
        // from a previous project folder does not — it is not in this repo's list, and keeping it left the
        // picker on its "nothing selected" placeholder
        const base = reconcileBaseRef({ branches: list, detected, current: wtBaseRefRef.current })
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
        setWtBaseRef(base)
      })
      .catch(() => {
        if (!cancelled) setBranches(null)
      })
    return () => {
      cancelled = true
    }
  }, [useWorktree, repoRoot])

  // 세션이 돌 폴더에서 검사한다 — 앱의 cwd 에서 돌리면 toolchain 관리자가 읽을 manifest 가 없어
  // 무조건 통과하고, 그 통과를 믿은 채 세션만 죽는다(설계 D3). 폴더가 바뀌면 다시 묻는다.
  //
  // 이 결과(cliOk/cliError)는 아래 cliFailsHere 경고에만 쓰인다 — 최종 리뷰 파동(F1) 전에는 시작
  // 버튼도 이 답을 기다렸고(checkingCli), 그래서 검사가 끝나기 전 최대 10초 동안 폴더를 고르고도
  // 버튼이 죽어 있었다. cliMissing 이 이제 "설치돼 있는지" 만 묻고 "이 폴더에서 도는지"는 F5 의
  // 우회 재시도가 살아서 처리하므로, 이 검사의 답은 더 이상 버튼을 막을 이유가 없다 — 그래서
  // checkingCli 플래그는 없앴다: 아무것도 결정하지 않는 불을 들고 있을 이유가 없다.
  useEffect(() => {
    if (!cwd) return
    let cancelled = false
    void window.api.system
      .checkCli(cwd)
      .then((c) => {
        if (cancelled) return
        setCliOk({ claude: c.claude.ok, codex: c.codex.ok })
        setCliError({ claude: c.claude.error, codex: c.codex.error })
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  useEffect(() => {
    // git repo check plus the default-account preselect. A worktree session uses the mapping keyed by the original repo too
    if (!cwd) return
    let cancelled = false
    setResolvingRepo(true) // disable the start button until the check finishes so nothing spawns with the previous repoRoot
    // Drop the branch list the moment the folder changes. It belongs to the previous repository, and until
    // the new fetch lands the picker would be offering branches that are not in this repo at all.
    setBranches(null)
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
  // The two questions kept apart (design D3, fix round 2) — see the cliInstalled/cliOk declarations
  // above for why one probe cannot safely answer both.
  const primaryInstalled = cliInstalled[primaryProvider]
  const primaryRunsHere = cliOk[primaryProvider]
  // Whether the CLI this account needs is missing from this machine at all — the only thing that
  // gates starting. primaryRunsHere (does it run in *this* folder) used to be folded in here too
  // (fix round 2), and that was the bug the final review wave found: a CLI a toolchain manager
  // refuses to run for this folder (Volta rejecting a broken package.json — the reviewer's own
  // machine) is exactly the case F5's one-shot bypass retry exists to survive, and gating Start on it
  // made that retry unreachable for the one machine it was built for — the shim was found, the
  // per-folder probe failed, Start stayed dead, nothing ever spawned, so the fix never ran. Kept out
  // of this flag on purpose now: primaryRunsHere still drives the cliFailsHere warning below (the
  // true, more specific statement) and F5 gets its chance. Still checked broadly, not just for a
  // plain single-account session — rolling supports codex too (codexCoordinator.ts) and so do Slack
  // notifications (turn completion is detected from rollout's task_complete), so this flag must not
  // hide either of those.
  const primaryCliMissing = !primaryInstalled
  // 대화 is available once the Host has announced the proc-* family — either provider's account can
  // open one. The poll lives in the hook, shared with ResumeDialog.
  const { enabled: chatEnabled, checking: chatChecking } = useChatAvailability()
  // The same login map the sidebar's account rows use — no new IPC. Only the roll slots consult it
  // (spec §15.4): slot 0 is where the user chose to run, and that choice fails visibly on its own.
  const { loginMap } = useAccountStatus(accounts)
  // A 대화 default falls back to 터미널 while it is unavailable — never written back, so the setting
  // survives a temporary gap (the Host still connecting) and chat is offered again once it clears.
  //
  // Gated on the Host having actually answered. Without that this fired on mount every time, because
  // an unanswered poll reads as "not enabled": the selection the setting had just seeded was dropped
  // before the Host could say yes, and nothing put it back afterwards (reported — the setting said
  // 대화 and the dialog opened on 터미널).
  useEffect(() => {
    if (kind === 'chat' && !chatEnabled && !chatChecking) setKind('terminal')
  }, [kind, chatEnabled, chatChecking])
  // Per-slot options: this slot's current value plus any account no other slot uses (no duplicates).
  // Rolling slots (1 and 2) only offer accounts with the same provider as the primary account, and
  // drop any account the login probe has answered "logged out" for (spec §15.4) — a slot already
  // holding an account keeps showing it regardless, so the control never renders with a value absent
  // from its own option list.
  const options = (slot: number): Account[] => {
    const live = slot === 0 ? null : new Set(rollChainCandidates(accounts.map((a) => a.id), loginMap))
    return accounts.filter(
      (a) =>
        (slot === 0 || provider(a) === primaryProvider) &&
        (a.id === accountIds[slot] || !accountIds.includes(a.id)) &&
        (live === null || a.id === accountIds[slot] || live.has(a.id))
    )
  }
  const canAdd =
    accountIds.length < MAX_ROLL_ACCOUNTS &&
    accounts.some(
      (a) =>
        provider(a) === primaryProvider && !accountIds.includes(a.id) && loginMap[a.id] !== false
    )
  // Whether rolling is on — with multiple accounts (2+) it is always on (checkbox pinned and disabled), with a single account the user toggles it
  const multi = accountIds.length >= 2
  // The current branch leads, outside any group: forking from what you are on is the common case, and the
  // automatic probe could never express it (it only looks at origin/*, main, master). orderBranchesForPicker
  // then puts remotes and locals in two runs — listBranches sorts the whole set by date, which interleaves
  // them and made the group headings repeat all the way down. Date order survives inside each run.
  const branchItems: SelectOption[] = orderBranchesForPicker(branches ?? []).map((b) => ({
    value: b.name,
    label: b.name,
    icon: <BranchGlyph />,
    group: b.current
      ? undefined
      : b.remote
        ? t('session.new.worktreeBaseRemote')
        : t('session.new.worktreeBaseLocal'),
    meta: b.current ? t('session.new.worktreeBaseCurrent') : b.updatedAt.slice(5, 10)
  }))

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
        // Rolling used to be terminal-only (a Host-owned line process had no CLI to hook a rolling
        // resume into) — since slice 4c 대화 rolls too, so nothing here is kind-gated any more.
        accountIds,
        cwd,
        saveDefault,
        kind,
        roll: rollChecked,
        rollPrompt: rollChecked ? rollPrompt.trim() || undefined : undefined,
        slackNotify: slackReady && slackNotify,
        bypassPermissions,
        ...(kind === 'chat' ? { unattendedPermission: unattended } : {}),
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

  const blocked = startBlockedBy({
    cwd: cwd ?? '',
    starting,
    resolvingRepo,
    accountIds,
    cliMissing: primaryCliMissing,
    schedOn,
    hasSchedule: schedule !== null
  })
  const BLOCKED_KEY: Record<StartBlocked, MessageKey> = {
    'no-cwd': 'session.new.blocked.noCwd',
    'no-account': 'session.new.blocked.noAccount',
    'cli-missing': 'session.new.blocked.cliMissing',
    'no-schedule': 'session.new.blocked.noSchedule',
    'checking-folder': 'session.new.blocked.checkingFolder'
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
        {/* Gated on the dedicated existence probe (cliInstalled), not on whether the per-folder check
            said anything — round 1 tried inferring "not installed" from an absent stderr line, but a
            shell running a binary it cannot find still writes its own "not recognized"/"not found",
            which reads exactly like the binary complaining once installed. That made a genuinely
            missing CLI take the "does not run in this folder" branch below instead of this one,
            hiding the install prompt for the one case that most needs it (design D3). */}
        {!primaryInstalled && (
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
        {/* The kind is the first decision — how the session runs at all — so it heads the form as its
            own section, ruled off from the folder and account it applies to. Placed between those two
            it read as one more field of the same run, and where the kind ended and the account began
            could not be told apart (reported from a hand check of the dialog). */}
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
              disabled={!chatEnabled}
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
        </div>
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
                {/* The container is a div, not a label. Clicking inside a <label> makes the browser forward
                    a second click to the control it labels — here the trigger button — so picking an item
                    closed the menu and the forwarded click reopened it straight away. The trigger carries
                    ariaLabel, so dropping the label element costs nothing. */}
                {branches && branches.length > 0 && (
                  <div className="worktree-base-row">
                    <span>{t('session.new.worktreeBaseRef')}</span>
                    <Select
                      items={branchItems}
                      value={wtBaseRef}
                      onChange={setWtBaseRef}
                      ariaLabel={t('session.new.worktreeBaseRef')}
                    />
                  </div>
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
                  <X size={12} />
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
        {/* Rolling now applies to 대화 too (slice 4c) — its resume path copies the transcript into
            the next account exactly as 터미널's does, so the same chain mechanism can hook into it.
            Unguarded by kind, with the schedule and Slack rows kept in the same order after it
            (spec §5.6). */}
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
            {/* Keep the placeholder in sync with the actual default claudeCoordinator.ts and codexCoordinator.ts send
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
        {/* The label follows the field below it: a 대화 gets a prompt sent as a new turn, a 터미널 gets a
            command run in its shell. */}
        <label className="row check-small">
          <input type="checkbox" checked={schedOn} onChange={(e) => setSchedOn(e.target.checked)} />
          {t(kind === 'chat' ? 'session.new.schedLabelChat' : 'session.new.schedLabel')}
        </label>
        {/* initial={schedule} restores the previous input when this is toggled off and back on —
            ScheduleFields loses its internal state on unmount, so the parent holds the last value that
            was valid (schedule) and feeds it back in. An intermediate input state with an empty command
            is not restored, because onChange emits null for it so it never reaches schedule — not a
            complete fix, but it covers the common case (toggling the checkbox). */}
        {schedOn && <ScheduleFields initial={schedule} onChange={setSchedule} chat={kind === 'chat'} />}
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
        {/* chat takeover P8: only meaningful for a chat session that is not already bypassing every
            prompt — a bypassed one never holds a prompt for this policy to apply to. */}
        {kind === 'chat' && !bypassPermissions && (
          <div className="field">
            <label>{t('chat.unattended.heading')}</label>
            <div className="kind-segmented">
              <button
                type="button"
                className={`segmented${unattended === 'hold' ? ' active' : ''}`}
                onClick={() => setUnattended('hold')}
              >
                {t('chat.unattended.hold')}
              </button>
              <button
                type="button"
                className={`segmented${unattended === 'deny-after-60s' ? ' active' : ''}`}
                onClick={() => setUnattended('deny-after-60s')}
              >
                {t('chat.unattended.deny60')}
              </button>
            </div>
          </div>
        )}
        {/* checkCli now runs in the chosen folder, not the app's own cwd, so a toolchain manager that
            refuses this folder's manifest gets caught here instead of killing the session after Start
            (design D3). Gated on primaryInstalled — the dedicated existence probe above — rather than
            on whether the per-folder check said anything, so this and the "not found" warning above
            are strictly mutually exclusive and neither can show for the wrong reason (fix round 2).
            When the per-folder check died inside its own timeout with nothing to say (a hung shell
            shim), there is no reason to quote — cliFailsHereUnknown reads sensibly without one instead
            of interpolating "undefined" into the sentence. */}
        {primaryInstalled && !primaryRunsHere && (
          <p className="warn-text">
            {cliError[primaryProvider] !== undefined
              ? t('session.new.cliFailsHere', {
                  cli: CLI_LABEL[primaryProvider],
                  reason: cliError[primaryProvider] as string
                })
              : t('session.new.cliFailsHereUnknown', { cli: CLI_LABEL[primaryProvider] })}
          </p>
        )}
        <div className="row right">
          <button onClick={onCancel} disabled={starting}>
            {t('common.cancel')}
          </button>
          <button className="primary" disabled={starting || blocked !== null} onClick={() => void start()}>
            {t('session.new.start')}
          </button>
        </div>
        {/* 왜 못 누르는지 말한다. 다섯 조건 중 둘은 비동기로 늦게 풀려서, 다 골라 놓고도 버튼이 죽어
            있다가 갑자기 살아나는 것처럼 보였다(설계 D4) */}
        {blocked !== null && (
          // 기다리면 풀리는 사유에만 스피너가 붙는다. 글씨만으로는 "내가 뭘 안 했나" 와 "앱이 일하는
          // 중" 이 똑같이 읽히고, 회색 버튼 앞에서 사람이 찾는 답이 바로 그 둘 중 어느 쪽이냐다.
          <p className="modal-hint start-blocked">
            {isWaitingReason(blocked) && <span className="loading-spinner small" aria-hidden="true" />}
            {t(BLOCKED_KEY[blocked])}
          </p>
        )}
      </div>
    </div>
  )
}
