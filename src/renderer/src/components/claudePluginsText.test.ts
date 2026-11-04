import { describe, it, expect } from 'vitest'
import { t as translate, LANGS, type MessageKey, type MessageParams } from '../../../core/i18n'
import {
  CODEX_CATCH_UP_MS,
  codexAttention,
  codexCatchingUp,
  codexLines,
  codexNotes,
  contentLines,
  dependencyLines,
  holdersHint,
  jobLine,
  offConfirmBody,
  ownCopyLines,
  pendingLines,
  pickedPluginIds,
  pluginChoices,
  refusalLabel,
  rowState,
  updateLabel
} from './claudePluginsText'
import type { ClaudePluginFailureCode, ClaudePluginJob, ClaudePluginRefusal, OfferedClaudePlugin } from '../../../core/extensions/claudePlugins/types'
import type { CodexPluginAccountState, CodexPluginFailureCode } from '../../../core/extensions/codexPlugins/types'

const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)
const ko = (key: MessageKey, params?: MessageParams): string => translate('ko', key, params)

// Records over the unions: a new refusal or failure code does not compile without being listed here
const REFUSALS = Object.keys({
  'user-config': 1, 'source-credential': 1, 'source-unsupported': 1, 'not-from-marketplace': 1, 'name-taken': 1, 'not-offered': 1
} satisfies Record<ClaudePluginRefusal | 'not-offered', 1>)
const CODES = Object.keys({
  'already-shared': 1, 'not-shared': 1, 'not-shareable': 1, 'marketplace-mismatch': 1, 'home-unreadable': 1, 'not-listed': 1,
  'dependency-missing': 1, 'catalog-unreadable': 1, 'store-unreadable': 1, refused: 1, 'timed-out': 1, 'name-taken': 1
} satisfies Record<ClaudePluginFailureCode, 1>) as ClaudePluginFailureCode[]
const CODEX_CODES = Object.keys({
  'marketplace-taken': 1, 'codex-unsupported': 1, 'config-unreadable': 1, 'hooks-unreadable': 1, refused: 1, 'timed-out': 1
} satisfies Record<CodexPluginFailureCode, 1>) as CodexPluginFailureCode[]

const LABELS: Record<string, string> = { c2: 'claude2@…', c4: 'claude4@…' }
const labelOf = (id: string): string => LABELS[id] ?? id

const job = (over: Partial<ClaudePluginJob>): ClaudePluginJob => ({ id: 'j1', kind: 'share', target: 'superpowers@obra', state: 'queued', startedAt: '2026-11-02T00:00:00.000Z', ...over })
const listed = { missing: false, update: undefined, enabled: true }

describe('claudePluginsText', () => {
  it('has words for every refusal and failure code in every language', () => {
    for (const lang of LANGS) {
      const tr = (key: MessageKey, params?: MessageParams): string => translate(lang, key, params)
      for (const r of REFUSALS) expect(refusalLabel(r, tr), `${lang} ${r}`).not.toMatch(/^settings\./)
      for (const code of CODES) expect(jobLine(job({ state: 'failed', code, message: 'detail' }), tr), `${lang} ${code}`).not.toMatch(/^settings\./)
    }
    // A reason this build does not know reads as the Host's own word
    expect(refusalLabel('something-new', en)).toBe('something-new')
  })

  it('says each job state, and nothing once a job is done', () => {
    expect(jobLine(job({ state: 'queued' }), ko)).toBe(ko('settings.extensions.plugin.queued'))
    expect(jobLine(job({ state: 'running', kind: 'share' }), ko)).toBe('설치하는 중…')
    expect(jobLine(job({ state: 'running', kind: 'update' }), ko)).toBe('설치하는 중…')
    expect(jobLine(job({ state: 'running', kind: 'check', target: undefined }), ko)).toBe(ko('settings.extensions.plugin.checking'))
    expect(jobLine(job({ state: 'running', kind: 'remove' }), ko)).toBe(ko('settings.extensions.plugin.removing'))
    expect(jobLine(job({ state: 'done' }), ko)).toBeNull()
    expect(jobLine(job({ state: 'needs-confirmation', command: { text: 'npx x', sha256: 'abc' } }), ko)).toBe(ko('settings.extensions.plugin.needsConfirmation'))
  })

  it('says a failure Astera decided in the person’s language, and Claude Code’s own message as it is', () => {
    expect(jobLine(job({ state: 'failed', code: 'marketplace-mismatch', message: 'marketplace obra is already in Astera’s plugin folder' }), ko)).toBe(
      '같은 이름의 마켓플레이스가 다른 주소로 이미 등록되어 있어 공유하지 않았습니다'
    )
    const claudes = 'Plugin "superpowers" not found in marketplace "obra"'
    expect(jobLine(job({ state: 'failed', message: claudes }), ko)).toBe(`실패: ${claudes}`)
    expect(jobLine(job({ state: 'failed', message: claudes }), en)).toBe(`Failed: ${claudes}`)
    // A code a newer Host sends that this build has no words for falls back to the message
    expect(jobLine(job({ state: 'failed', code: 'brand-new' as ClaudePluginFailureCode, message: 'why' }), en)).toBe('Failed: why')
  })

  it('says a share refused in the queue for a taken name with the refusal’s own words', () => {
    const taken = job({ state: 'failed', code: 'name-taken', message: 'superpowers@one is already shared under the name superpowers' })
    expect(jobLine(taken, ko)).toBe(ko('settings.extensions.plugin.reason.name-taken'))
    expect(jobLine(taken, en)).toBe(en('settings.extensions.plugin.reason.name-taken'))
    expect(jobLine(taken, ko)).toBe(refusalLabel('name-taken', ko))
  })

  it('puts missing files before an update, and an update before off', () => {
    expect(rowState({ ...listed, missing: true, update: { version: '2.0.0', fingerprint: 'f', checkedAt: 'now' }, enabled: false })).toBe('missing')
    expect(rowState({ ...listed, update: { version: '2.0.0', fingerprint: 'f', checkedAt: 'now' }, enabled: false })).toBe('update')
    expect(rowState({ ...listed, enabled: false })).toBe('off')
    expect(rowState(listed)).toBe('ok')
  })

  it('names the versions of an update only when the catalog says a different one', () => {
    expect(updateLabel('6.3.0', '7.0.0', ko)).toBe('업데이트 있음 (6.3.0 → 7.0.0)')
    expect(updateLabel('6.3.0', null, ko)).toBe('업데이트 있음')
    // R3: a catalog edit that kept the version
    expect(updateLabel('6.3.0', '6.3.0', ko)).toBe('업데이트 있음')
  })

  it('lists the accounts holding a plugin with commas, and marks one where it is off', () => {
    const holders = [
      { accountId: 'c2', version: '7.0.0', enabled: true },
      { accountId: 'c4', version: '6.3.0', enabled: true }
    ]
    expect(holdersHint(holders, labelOf, en)).toBe('claude2@… 7.0.0, claude4@… 6.3.0')
    expect(holdersHint(holders, labelOf, en)).not.toContain('·')
    expect(holdersHint([{ accountId: 'c2', version: '7.0.0', enabled: false }], labelOf, en)).toBe('claude2@… 7.0.0 (Off)')
  })

  it('names, on Off and Remove, each account whose own copy runs instead, with its version (P4)', () => {
    const p = {
      accountCopies: [
        { accountId: 'c2', version: '7.0.0', enabled: true },
        { accountId: 'c4', version: '6.3.0', enabled: true }
      ],
      requiredBy: []
    }
    expect(offConfirmBody(p, labelOf, ko)).toBe('끄면 다음 세션부터 이 계정들은 자기 버전을 씁니다: claude2@… 7.0.0, claude4@… 6.3.0')
    expect(offConfirmBody(p, labelOf, ko, 'remove')).toBe(ko('settings.extensions.plugin.removeBody', { list: 'claude2@… 7.0.0, claude4@… 6.3.0' }))
    expect(offConfirmBody({ accountCopies: [], requiredBy: [] }, labelOf, ko)).toBe('끄면 다음 세션부터 이 플러그인을 쓰지 않습니다.')
    expect(offConfirmBody({ accountCopies: [], requiredBy: [] }, labelOf, ko, 'remove')).toBe(ko('settings.extensions.plugin.removeBodyNone'))
    // An account where its own copy is switched off does not run it instead
    expect(offConfirmBody({ accountCopies: [{ accountId: 'c2', version: '7.0.0', enabled: false }], requiredBy: [] }, labelOf, ko)).toBe(
      ko('settings.extensions.plugin.offBodyNone')
    )
  })

  it('says a plugin still loads while a shared plugin that needs it is on', () => {
    const body = offConfirmBody({ accountCopies: [], requiredBy: ['a@m', 'b@m'] }, labelOf, ko)
    expect(body.split('\n')).toEqual([ko('settings.extensions.plugin.offBodyNone'), ko('settings.extensions.plugin.offRequiredBy', { list: 'a@m, b@m' })])
    expect(body).toContain('a@m, b@m')
  })

  // K4: the plugins of the account picked in the register menu are choices of its own dialog
  it('offers each shareable plugin with the version a share would install, and lists the refused ones with why', () => {
    const found: OfferedClaudePlugin[] = [
      { id: 'superpowers@obra', name: 'superpowers', marketplace: 'obra', holders: [{ accountId: 'c2', version: '7.0.0', enabled: true }], source: { source: 'github', repo: 'obra/superpowers-marketplace' }, sourceAccountId: 'c2', shareable: true, offeredVersion: '7.1.0' },
      { id: 'hud@obra', name: 'hud', marketplace: 'obra', holders: [{ accountId: 'c2', version: '1.0.0', enabled: true }], source: { source: 'github', repo: 'obra/superpowers-marketplace' }, sourceAccountId: 'c2', shareable: true, offeredVersion: null },
      { id: 'keyed@corp', name: 'keyed', marketplace: 'corp', holders: [{ accountId: 'c2', version: '1.0.0', enabled: true }], source: null, sourceAccountId: 'c2', shareable: false, reason: 'source-credential', offeredVersion: null }
    ]
    const p = pluginChoices(found, en)
    // The account is the one picked, so no choice names its holders; the version is a line of its own when the catalog says
    expect(p.choices).toEqual([
      { id: 'plugin:superpowers@obra', label: 'Plugin superpowers@obra', hint: en('settings.extensions.plugin.offeredVersion', { version: '7.1.0' }), defaultChecked: false },
      { id: 'plugin:hud@obra', label: 'Plugin hud@obra', defaultChecked: false }
    ])
    expect(p.choices[1]).not.toHaveProperty('hint')
    expect(pluginChoices(found, ko).choices[0]).toMatchObject({ label: '플러그인 superpowers@obra', hint: '설치될 버전 7.1.0' })
    expect(p.refused).toEqual([`keyed@corp: ${en('settings.extensions.plugin.reason.source-credential')}`])
    expect(pluginChoices([], en)).toEqual({ choices: [], refused: [] })
  })

  it('names the plugins picked in the dialog, apart from the items', () => {
    expect(pickedPluginIds(['item:skill:review', 'plugin:superpowers@obra', 'item:mcp:linear', 'plugin:hud@obra'])).toEqual(['superpowers@obra', 'hud@obra'])
    expect(pickedPluginIds(['item:skill:review'])).toEqual([])
    expect(pickedPluginIds([])).toEqual([])
  })

  // §5.9: the expanded row names the account copies whether the shared plugin is on or off, worded by what runs
  it('words each account copy by whether the shared plugin is on, and whether the account’s own copy is', () => {
    const accountCopies = [
      { accountId: 'c2', version: '7.0.0', enabled: true },
      { accountId: 'c4', version: '6.3.0', enabled: false }
    ]
    expect(ownCopyLines({ enabled: true, accountCopies }, labelOf, ko)).toEqual([
      'claude2@…: 자기 버전 7.0.0 대신 공유 버전을 씀',
      'claude4@…: 자기 버전 6.3.0 대신 공유 버전을 씀'
    ])
    expect(ownCopyLines({ enabled: false, accountCopies }, labelOf, ko)).toEqual([
      ko('settings.extensions.plugin.ownCopyOff', { account: 'claude2@…', version: '7.0.0' }),
      // Its own copy is switched off in that account, so it runs neither
      ko('settings.extensions.plugin.ownCopyOffDisabled', { account: 'claude4@…', version: '6.3.0' })
    ])
    expect(ownCopyLines({ enabled: false, accountCopies: [] }, labelOf, ko)).toEqual([])
  })

  // §5.4: what Claude Code installed with the plugin is shown under it
  it('says each dependency with its version, one line each', () => {
    expect(dependencyLines([{ id: 'base@obra', version: '1.2.0', installPath: '/x' }, { id: 'tools@other', version: '0.3.0', installPath: '/y' }], en)).toEqual([
      en('settings.extensions.plugin.dependency', { name: 'base@obra', version: '1.2.0' }),
      en('settings.extensions.plugin.dependency', { name: 'tools@other', version: '0.3.0' })
    ])
    expect(dependencyLines([], en)).toEqual([])
  })

  // §5.9: what the plugin brings, a line a kind it has, with the count and the names
  it('says what a plugin brings, a line a kind, and nothing for a kind it lacks', () => {
    const lines = contentLines({ skills: ['brainstorm', 'review'], commands: [], agents: ['critic'], mcpServers: ['linear'], hooks: true }, ko)
    expect(lines).toEqual([
      ko('settings.extensions.plugin.contents.skills', { count: 2, list: 'brainstorm, review' }),
      ko('settings.extensions.plugin.contents.agents', { count: 1, list: 'critic' }),
      ko('settings.extensions.plugin.contents.mcpServers', { count: 1, list: 'linear' }),
      ko('settings.extensions.plugin.contents.hooks')
    ])
    expect(lines[0]).toContain('2')
    expect(lines[0]).toContain('brainstorm, review')
    expect(contentLines({ skills: [], commands: ['ship'], agents: [], mcpServers: [], hooks: false }, en)).toEqual([en('settings.extensions.plugin.contents.commands', { count: 1, list: 'ship' })])
    // A Host that does not say
    expect(contentLines(undefined, en)).toEqual([])
  })

  // §5.8: one line per Codex account, in the order the accounts are listed
  describe('the Codex accounts of a plugin', () => {
    const plugin = { name: 'superpowers', version: '7.0.0' }
    const row = (over: Partial<CodexPluginAccountState>): CodexPluginAccountState => ({ accountId: 'x1', installed: {}, waiting: false, turnedOff: [], at: '2026-11-04T00:00:00.000Z', ...over })
    const names: Record<string, string> = { x1: 'codex1@…', x2: 'codex2@…', x3: 'codex3@…' }
    const codexLabel = (id: string): string => names[id] ?? id

    it('has words for every Codex failure code in every language', () => {
      for (const lang of LANGS) {
        const tr = (key: MessageKey, params?: MessageParams): string => translate(lang, key, params)
        for (const code of CODEX_CODES) {
          const [line] = codexLines(plugin, [row({ failure: { message: 'detail', code } })], ['x1'], codexLabel, tr)
          expect(line, `${lang} ${code}`).not.toMatch(/settings\./)
          expect(line, `${lang} ${code}`).not.toContain('detail')
        }
        for (const key of ['installed', 'waiting', 'pending', 'held', 'turnedOff', 'noteAgents', 'noteCommands', 'noteHooks'] as const) {
          expect(tr(`settings.extensions.plugin.codex.${key}`, { account: 'a', version: 'v', id: 'i', name: 'n' }), `${lang} ${key}`).not.toMatch(/^settings\./)
        }
      }
    })

    it('says installed, waiting and not installed yet, in the order the accounts are listed', () => {
      const rows = [
        row({ accountId: 'x2', waiting: true }),
        row({ accountId: 'x1', installed: { superpowers: '7.0.0' } })
      ]
      // x3 has no row at all
      expect(codexLines(plugin, rows, ['x1', 'x2', 'x3'], codexLabel, ko)).toEqual([
        'codex1@… (Codex): 7.0.0 설치됨',
        'codex2@… (Codex): 이 계정의 세션이 끝나면 적용됩니다',
        'codex3@… (Codex): 아직 설치하지 않았습니다'
      ])
      expect(codexLines(plugin, rows, ['x1', 'x2', 'x3'], codexLabel, en)).toEqual([
        'codex1@… (Codex): 7.0.0 installed',
        "codex2@… (Codex): applies when this account's sessions end",
        'codex3@… (Codex): not installed yet'
      ])
    })

    it('says not installed yet for a row that holds other plugins but not this one', () => {
      expect(codexLines(plugin, [row({ installed: { other: '1.0.0' } })], ['x1'], codexLabel, en)).toEqual(['codex1@… (Codex): not installed yet'])
    })

    it('says the version Codex has, even one other than the shared version', () => {
      expect(codexLines(plugin, [row({ installed: { superpowers: '6.3.0' } })], ['x1'], codexLabel, en)).toEqual(['codex1@… (Codex): 6.3.0 installed'])
    })

    // The Host keeps the installs when only the trust of the hooks failed, and the row's attention mark points at the line
    it('says a failure even where the plugin is installed, so the attention mark has its reason', () => {
      const failed = row({ installed: { superpowers: '7.0.0' }, failure: { message: 'app-server timed out', code: 'hooks-unreadable' } })
      expect(codexLines(plugin, [failed], ['x1'], codexLabel, en)).toEqual(['codex1@… (Codex): the hooks could not be listed, so they were not trusted'])
    })

    // Final review I2: the Host lists a plugin as held only in an account that has it installed
    it('says a held plugin keeps the previous version, waiting or not, and one held where it is absent is not installed yet', () => {
      expect(codexLines(plugin, [row({ installed: { superpowers: '6.3.0' }, held: ['superpowers'] })], ['x1'], codexLabel, ko)).toEqual([
        'codex1@… (Codex): 새 버전을 Codex에 맞게 바꾸지 못해 이전 버전을 그대로 둡니다'
      ])
      expect(codexLines(plugin, [row({ installed: { superpowers: '6.3.0' }, held: ['superpowers'], waiting: true })], ['x1'], codexLabel, en)).toEqual([
        'codex1@… (Codex): the new version could not be converted for Codex, so the previous one stays'
      ])
      expect(codexLines(plugin, [row({ installed: { other: '1.0.0' }, held: ['other'] })], ['x1'], codexLabel, en)).toEqual(['codex1@… (Codex): not installed yet'])
    })

    it('says a waiting account is waiting for this plugin only when it is not at the shared version yet', () => {
      expect(codexLines(plugin, [row({ installed: { superpowers: '6.3.0' }, waiting: true })], ['x1'], codexLabel, en)).toEqual([
        "codex1@… (Codex): applies when this account's sessions end"
      ])
      // The account waits for another plugin; this one is installed at the shared version
      expect(codexLines(plugin, [row({ installed: { superpowers: '7.0.0' }, waiting: true })], ['x1'], codexLabel, en)).toEqual(['codex1@… (Codex): 7.0.0 installed'])
    })

    it('words a failure Astera decided, and shows Codex’s own message as it is when there is no code or this build does not know it', () => {
      const lines = (failure: CodexPluginAccountState['failure'], t: typeof en): string[] => codexLines(plugin, [row({ failure })], ['x1'], codexLabel, t)
      expect(lines({ message: 'm', code: 'marketplace-taken' }, ko)).toEqual(['codex1@… (Codex): 같은 이름의 마켓플레이스가 다른 곳에서 이미 등록되어 있습니다'])
      expect(lines({ message: 'm', code: 'codex-unsupported' }, en)).toEqual(['codex1@… (Codex): this Codex has no plugin command (checked on 0.160)'])
      expect(lines({ message: 'm', code: 'config-unreadable' }, ko)).toEqual(['codex1@… (Codex): config.toml을 읽지 못했습니다'])
      expect(lines({ message: 'm', code: 'hooks-unreadable' }, ko)).toEqual(['codex1@… (Codex): 훅 목록을 읽지 못해 훅을 신뢰하지 못했습니다'])
      // The Codex wording: the Claude wording of the same words names claude
      expect(lines({ message: 'm', code: 'refused' }, en)).toEqual(['codex1@… (Codex): Nothing was run: it holds characters that cannot be passed to codex on this computer'])
      expect(lines({ message: 'm', code: 'timed-out' }, ko)).toEqual(['codex1@… (Codex): Codex 가 제시간에 끝나지 않아 멈췄습니다'])
      expect(lines({ message: 'codex plugin add exited with 2' }, en)).toEqual(['codex1@… (Codex): codex plugin add exited with 2'])
      expect(lines({ message: 'newer words', code: 'brand-new' as CodexPluginFailureCode }, en)).toEqual(['codex1@… (Codex): newer words'])
    })

    it('adds a line for each own plugin of the same name that Astera turned off', () => {
      const turned = row({ installed: { superpowers: '7.0.0' }, turnedOff: ['superpowers@openai-curated', 'other@openai-curated', 'superpowers-extras@x'] })
      expect(codexLines(plugin, [turned], ['x1'], codexLabel, ko)).toEqual([
        'codex1@… (Codex): 7.0.0 설치됨',
        'codex1@… (Codex): 계정에 있던 superpowers@openai-curated를 껐습니다'
      ])
      expect(codexLines(plugin, [turned], ['x1'], codexLabel, en)[1]).toBe("codex1@… (Codex): turned off the account's own superpowers@openai-curated")
    })

    it('says nothing without a Codex account, and nothing of a row whose account is gone', () => {
      expect(codexLines(plugin, [row({ accountId: 'gone', installed: { superpowers: '7.0.0' } })], [], codexLabel, en)).toEqual([])
      expect(codexLines(plugin, [row({ accountId: 'gone', installed: { superpowers: '7.0.0' } })], ['x1'], codexLabel, en)).toEqual(['codex1@… (Codex): not installed yet'])
    })

    it('notes what Codex does differently, a note for each of agents, commands and hooks the plugin has', () => {
      const all = { ...plugin, contents: { skills: ['a'], commands: ['ship'], agents: ['critic'], mcpServers: [], hooks: true } }
      expect(codexNotes(all, ko)).toEqual([
        'Codex에서는 에이전트가 빠집니다',
        'Codex에서는 명령이 superpowers:source-command-<이름> 스킬이 됩니다',
        '훅은 Astera가 Codex 계정마다 신뢰해 두었습니다'
      ])
      expect(codexNotes(all, en)).toEqual([
        'Codex leaves the agents out',
        'In Codex, commands become skills named superpowers:source-command-<name>',
        'Astera has trusted the hooks in each Codex account'
      ])
      expect(codexNotes({ ...plugin, contents: { skills: ['a'], commands: [], agents: [], mcpServers: ['m'], hooks: false } }, en)).toEqual([])
      expect(codexNotes({ ...plugin, contents: { skills: [], commands: [], agents: ['critic'], mcpServers: [], hooks: false } }, en)).toEqual(['Codex leaves the agents out'])
      // A Host that does not say what it brings
      expect(codexNotes(plugin, en)).toEqual([])
    })

    it('asks for a look when any Codex account failed', () => {
      expect(codexAttention(plugin, [row({}), row({ accountId: 'x2', failure: { message: 'm' } })])).toBe(true)
      expect(codexAttention(plugin, [row({}), row({ accountId: 'x2', waiting: true })])).toBe(false)
      expect(codexAttention(plugin, [])).toBe(false)
    })

    // The Codex sync starts after a plugin job ends and runs codex in each account, so the outcome rows trail the job
    describe('while the Codex outcome catches up with the last job', () => {
      const ENDED = '2026-11-04T12:00:00.000Z'
      const endedAt = Date.parse(ENDED)
      const ended = (over: Partial<ClaudePluginJob> = {}): ClaudePluginJob => job({ state: 'done', endedAt: ENDED, ...over })
      const at = (offsetMs: number): string => new Date(endedAt + offsetMs).toISOString()
      const catching = (jobs: ClaudePluginJob[], rows: CodexPluginAccountState[], ids: string[], nowMs = endedAt + 1000): boolean => codexCatchingUp(jobs, rows, ids, nowMs)

      it('does while a listed account has no row, or a row older than the job ended', () => {
        expect(catching([ended()], [], ['x1'])).toBe(true)
        expect(catching([ended()], [row({ at: at(-60_000) })], ['x1'])).toBe(true)
        // One of two accounts has caught up
        expect(catching([ended()], [row({ at: at(2000) }), row({ accountId: 'x2', at: at(-5000) })], ['x1', 'x2'])).toBe(true)
        expect(catching([ended()], [row({ at: at(2000) })], ['x1', 'x2'])).toBe(true)
      })

      it('does not once every listed account has a row from after the job ended', () => {
        expect(catching([ended()], [row({ at: at(2000) }), row({ accountId: 'x2', at: at(500) })], ['x1', 'x2'])).toBe(false)
        // Written at the moment it ended counts as after
        expect(catching([ended()], [row({ at: ENDED })], ['x1'])).toBe(false)
      })

      it('does not for rows of accounts that are not listed', () => {
        expect(catching([ended()], [row({ at: at(2000) }), row({ accountId: 'gone', at: at(-60_000) })], ['x1'])).toBe(false)
      })

      it('adds nothing without a listed Codex account', () => {
        expect(catching([ended()], [], [])).toBe(false)
        expect(catching([ended()], [row({ at: at(-60_000) })], [])).toBe(false)
      })

      it('adds nothing without a job that ended, and a check is not one', () => {
        expect(catching([], [], ['x1'])).toBe(false)
        expect(catching([job({ state: 'running' }), job({ id: 'q', state: 'queued' })], [], ['x1'])).toBe(false)
        expect(catching([ended({ kind: 'check', target: undefined })], [], ['x1'])).toBe(false)
        // A check that ended later does not move the mark: the share's own end is what the row is compared with
        expect(catching([ended(), ended({ id: 'c', kind: 'check', target: undefined, endedAt: at(30_000) })], [row({ at: at(2000) })], ['x1'], endedAt + 31_000)).toBe(false)
      })

      it('goes by the latest job that ended', () => {
        const later = ended({ id: 'later', kind: 'update', endedAt: at(60_000) })
        expect(catching([ended(), later], [row({ at: at(30_000) })], ['x1'], endedAt + 61_000)).toBe(true)
        expect(catching([ended(), later], [row({ at: at(62_000) })], ['x1'], endedAt + 63_000)).toBe(false)
      })

      it('stops 3 minutes after the job ended, however the rows stand', () => {
        expect(CODEX_CATCH_UP_MS).toBe(3 * 60_000)
        expect(catching([ended()], [], ['x1'], endedAt + CODEX_CATCH_UP_MS - 1)).toBe(true)
        expect(catching([ended()], [], ['x1'], endedAt + CODEX_CATCH_UP_MS)).toBe(false)
      })

      it('reads a time it cannot parse as nothing to wait for', () => {
        expect(catching([ended({ endedAt: 'sometime' })], [], ['x1'])).toBe(false)
        expect(catching([ended()], [row({ at: 'sometime' })], ['x1'])).toBe(false)
      })
    })
  })

  it('says where a job stands for a plugin not in the list yet, by its latest job', () => {
    const jobs = [
      job({ id: '1', target: 'a@m', state: 'failed', message: 'first try' }),
      job({ id: '2', target: 'b@m', state: 'running' }),
      job({ id: '3', target: 'shared@m', state: 'running', kind: 'update' }),
      job({ id: '4', target: 'a@m', state: 'queued' }),
      job({ id: '5', target: 'c@m', state: 'done', kind: 'remove' }),
      job({ id: '6', target: 'd@m', state: 'failed', kind: 'remove', message: 'locked' }),
      job({ id: '7', kind: 'check', target: undefined, state: 'running' })
    ]
    expect(pendingLines(jobs, new Set(['shared@m']), en)).toEqual([
      { id: 'a@m', line: en('settings.extensions.plugin.queued'), stopped: false },
      { id: 'b@m', line: 'Installing…', stopped: false },
      { id: 'd@m', line: 'Failed: locked', stopped: true }
    ])
  })
})
