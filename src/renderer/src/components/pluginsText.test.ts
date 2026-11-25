import { describe, it, expect } from 'vitest'
import { t as translate, type MessageKey, type MessageParams } from '../../../core/i18n'
import { PLUGIN_TRUST_WARNING } from '../../../core/plugins/manifest'
import type { SettingField } from '../../../core/plugins/settings'
import { configureChanges, configureDoneLine, failureLine, installFailureLine, installPrompt, npmNotice, permissionLabel, reasonLine, statusLabel, trustLabel } from './pluginsText'

const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)
const ko = (key: MessageKey, params?: MessageParams): string => translate('ko', key, params)
const lf = String.fromCharCode(10)

const INSPECTION = {
  id: '@acme/astera-jira',
  name: '@acme/astera-jira',
  displayName: 'Jira',
  version: '1.0.0',
  apiVersion: '1',
  entry: './dist/plugin.js',
  capabilities: [],
  permissions: ['jobs.read', 'jobs.create'],
  compatible: true
}

describe('permissionLabel and statusLabel', () => {
  it('names each permission of the vocabulary in words, and an unknown one by its name', () => {
    expect(permissionLabel('jobs.read', en)).toBe('Read Jobs')
    expect(permissionLabel('jobs.create', en)).toBe('Create Jobs')
    expect(permissionLabel('events.subscribe', en)).toBe('Subscribe to events')
    expect(permissionLabel('network.raw', en)).toBe('network.raw')
    for (const p of ['projects.read', 'jobs.read', 'jobs.create', 'jobs.run', 'runs.read', 'runs.control', 'tasks.read', 'tasks.write', 'questions.read', 'questions.answer', 'completion.read', 'events.subscribe', 'github.read', 'github.write', 'how-it-works.read'])
      expect(permissionLabel(p, ko), p).not.toBe(p)
  })

  it('names each status, and an unknown one by itself', () => {
    expect(['running', 'starting', 'stopped', 'failed', 'disabled', 'incompatible'].map((s) => statusLabel(s, en))).toEqual([
      'Running',
      'Starting',
      'Stopped',
      'Failed',
      'Disabled',
      'Incompatible'
    ])
    expect(statusLabel('paused', en)).toBe('paused')
  })
})

describe('installPrompt (spec §31)', () => {
  // 2d final review M7: spec §31 lists the permissions, then the trust sentence, then the buttons.
  it('asks for each permission, all checked, and puts the trust sentence after them', () => {
    const p = installPrompt(INSPECTION, 'D:/work/jira 플러그인', en)
    expect(p.title).toBe('Jira plugin requests:')
    expect(p.choices).toEqual([
      { id: 'jobs.read', label: 'Read Jobs', hint: 'jobs.read', defaultChecked: true },
      { id: 'jobs.create', label: 'Create Jobs', hint: 'jobs.create', defaultChecked: true }
    ])
    expect(p.body.split(lf)).toEqual(['@acme/astera-jira, version 1.0.0', 'From D:/work/jira 플러그인'])
    expect(p.footer.split(lf)).toEqual(['A permission you uncheck is not granted.', '', PLUGIN_TRUST_WARNING])
    expect(p.confirmLabel).toBe('Install')
  })

  // 2d final review I2: an update asks again (design P6), and what the person withheld stays unchecked.
  it('leaves unchecked on an update what was withheld before, and checks what is newly asked for', () => {
    const p = installPrompt(
      { ...INSPECTION, permissions: ['jobs.read', 'jobs.create', 'events.subscribe'], installed: { version: '0.9.0', enabled: true } },
      'D:/work/jira',
      en,
      { permissions: ['jobs.read'], requested: ['jobs.read', 'jobs.create'] }
    )
    expect(p.choices).toEqual([
      { id: 'jobs.read', label: 'Read Jobs', hint: 'jobs.read', defaultChecked: true },
      { id: 'jobs.create', label: 'Create Jobs', hint: 'jobs.create · not granted before', defaultChecked: false },
      { id: 'events.subscribe', label: 'Subscribe to events', hint: 'events.subscribe', defaultChecked: true }
    ])
  })

  it('says what it replaces, what it does, why it will not run, what it serves, and that it asks for nothing', () => {
    const p = installPrompt(
      {
        ...INSPECTION,
        description: 'Turns Jira issues into Jobs',
        capabilities: ['job-source'],
        permissions: [],
        compatible: false,
        reason: 'this Astera does not serve job-source plugins yet',
        installed: { version: '0.9.0', enabled: true }
      },
      'D:/work/jira',
      en
    )
    expect(p.choices).toEqual([])
    expect(p.body.split(lf)).toEqual([
      '@acme/astera-jira, version 1.0.0',
      'From D:/work/jira',
      'It replaces the installed version 0.9.0.',
      'Turns Jira issues into Jobs',
      'Capabilities: job-source',
      'It will not run on this Astera: this Astera does not serve job-source plugins yet'
    ])
    expect(p.footer.split(lf)).toEqual(['It asks for no permissions.', '', PLUGIN_TRUST_WARNING])
  })

  // Plugins 2e: a package from npm says so where a folder would be named.
  it('names the npm package it comes from', () => {
    // The words the user chose on 2026-10-13: the package, where it comes from.
    expect(installPrompt({ ...INSPECTION, source: { npm: '@acme/astera-jira@^1.0.0', version: '1.0.0' } }, { npm: '@acme/astera-jira@^1.0.0' }, en).body.split(lf)[1]).toBe(
      'From the npm package @acme/astera-jira@^1.0.0'
    )
    expect(installPrompt(INSPECTION, { npm: '@acme/astera-jira' }, ko).body.split(lf)[1]).toBe('출처: npm 패키지 @acme/astera-jira')
    expect(ko('settings.plugins.installNpm')).toBe('패키지 이름으로 설치')
    expect(ko('settings.plugins.npmPlaceholder')).toBe('패키지 이름 (예: @acme/astera-jira)')
  })

  it('reads in Korean too', () => {
    expect(installPrompt(INSPECTION, 'D:/x', ko).footer).toContain('신뢰된 코드')
  })
})

describe('configureChanges (spec §23, §24)', () => {
  const fields: SettingField[] = [
    { key: 'baseUrl', type: 'string', required: true },
    { key: 'pageSize', type: 'integer', default: 50, enum: [25, 50, 100], required: false },
    { key: 'ratio', type: 'number', required: false },
    { key: 'dryRun', type: 'boolean', default: false, required: false },
    { key: 'token', type: 'string', secret: true, required: true },
    { key: 'spare', type: 'string', secret: true, required: false }
  ]
  const shown = { values: { baseUrl: 'https://a.example.com', pageSize: 50, ratio: 1.5, dryRun: false }, secrets: { token: 'set', spare: 'unset' } }

  it('is nothing when nothing was touched, or touched back to what it was', () => {
    expect(configureChanges(fields, shown, {}, new Set())).toBeNull()
    expect(configureChanges(fields, shown, { baseUrl: 'https://a.example.com', pageSize: '50', dryRun: false }, new Set())).toBeNull()
  })

  it('sets what changed, as typed, and a boolean as a boolean', () => {
    expect(configureChanges(fields, shown, { baseUrl: 'https://b.example.com', pageSize: '100', ratio: '2.5', dryRun: true }, new Set())).toEqual({
      set: { baseUrl: 'https://b.example.com', pageSize: '100', ratio: '2.5', dryRun: true },
      unset: []
    })
  })

  // 2d final review M6: a boolean with no value and no default shows unchecked; unchecking it again changes nothing.
  it('sees a boolean turned on and off again as no change', () => {
    const flag: SettingField[] = [{ key: 'flag', type: 'boolean', required: false }]
    expect(configureChanges(flag, { values: {}, secrets: {} }, { flag: false }, new Set())).toBeNull()
    expect(configureChanges(flag, { values: {}, secrets: {} }, { flag: true }, new Set())).toEqual({ set: { flag: true }, unset: [] })
  })

  it('unsets an emptied field, unless what it showed was its default', () => {
    expect(configureChanges(fields, shown, { ratio: '' }, new Set())).toEqual({ set: {}, unset: ['ratio'] })
    expect(configureChanges(fields, shown, { pageSize: '' }, new Set())).toBeNull()
  })

  it('leaves a secret alone when its box is empty, sets it when typed in, and unsets it only when cleared', () => {
    expect(configureChanges(fields, shown, { token: '' }, new Set())).toBeNull()
    expect(configureChanges(fields, shown, { token: 'tok-2' }, new Set())).toEqual({ set: { token: 'tok-2' }, unset: [] })
    expect(configureChanges(fields, shown, {}, new Set(['token']))).toEqual({ set: {}, unset: ['token'] })
    expect(configureChanges(fields, shown, {}, new Set(['spare']))).toBeNull()
  })
})

describe('configureDoneLine', () => {
  it('says how the plugin stands after a save', () => {
    expect(configureDoneLine({ status: 'running', restarted: true }, en)).toBe('Saved. The plugin was restarted.')
    expect(configureDoneLine({ status: 'starting' }, en)).toBe('Saved. The plugin is starting.')
    // 2d final review M1: the Host's own sentence (manager.ts heldBack), said in the app's words.
    expect(configureDoneLine({ status: 'stopped', reason: 'needs settings: token; set them with astera plugins configure --id @acme/jira' }, en)).toBe(
      'Saved. It still needs settings: token.'
    )
    expect(configureDoneLine({ status: 'stopped', reason: 'the settings cannot be read: x' }, en)).toBe('Saved. It does not run yet: the settings cannot be read: x')
    expect(configureDoneLine({ status: 'failed', reason: 'activate threw: x' }, en)).toBe('Saved. It failed before, and starts again only when you press Start again.')
    expect(configureDoneLine({ status: 'disabled' }, en)).toBe('Saved. It is disabled, and starts with these values when you enable it.')
    expect(configureDoneLine({ status: 'stopped' }, en)).toBe('Saved.')
  })
})

// Found on the dev app: the Host's reason for a held-back plugin points at the CLI, in English, beside a Configure button.
describe('reasonLine', () => {
  it('says which settings a held-back plugin needs, in the app’s words', () => {
    expect(reasonLine('needs settings: baseUrl, token; set them with astera plugins configure --id @acme/jira', en)).toBe(
      'Needs settings: baseUrl, token. Set them with Configure.'
    )
  })

  it('gives any other reason as the Host said it', () => {
    expect(reasonLine('activate threw: 401 for [redacted] (3 times in a row, each within 30 s of starting)', en)).toBe(
      'activate threw: 401 for [redacted] (3 times in a row, each within 30 s of starting)'
    )
    expect(reasonLine('', en)).toBe('')
  })
})

describe('failureLine', () => {
  it('says in the app’s words that no Host is there, that it runs no plugins, or that it did not answer', () => {
    expect(failureLine({ ok: false, code: 'HOST_NOT_RUNNING', message: 'x' }, en)).toBe('The app is not connected to the Host.')
    expect(failureLine({ ok: false, code: 'NOT_SUPPORTED', message: 'unknown command: plugins-list' }, en)).toBe(
      'The running Host does not support plugins (unknown command: plugins-list). Restart the Host.'
    )
    expect(failureLine({ ok: false, code: 'TIMEOUT', message: 'x' }, en)).toBe('The Host did not answer in time. The list shows whether it was done.')
    expect(failureLine({ ok: false, code: 'HOST_LOST', message: 'x' }, en)).toBe('The connection to the Host closed. The list shows whether it was done.')
  })

  // 2d final review I1: a read that failed is the list itself; it does not send the person to the list.
  it('says a read was not answered without pointing at the list', () => {
    expect(failureLine({ ok: false, code: 'TIMEOUT', message: 'x' }, en, { read: true })).toBe('The Host did not answer in time.')
    expect(failureLine({ ok: false, code: 'HOST_LOST', message: 'x' }, en, { read: true })).toBe('The connection to the Host closed.')
    expect(failureLine({ ok: false, code: 'TIMEOUT', message: 'x' }, ko, { read: true })).toBe('Host 가 제때 답하지 않았습니다.')
    expect(failureLine({ ok: false, code: 'HOST_NOT_RUNNING', message: 'x' }, en, { read: true })).toBe('The app is not connected to the Host.')
  })

  // 2e final review M4: the Host's sentence points at a CLI flag; the app has a folder button instead.
  it('says npm is missing in the app’s words, pointing at the folder button', () => {
    const missing = { ok: false as const, code: 'PLUGIN_NPM_MISSING', message: 'npm was not found on this computer: ... with --path' }
    expect(failureLine(missing, en)).toBe('npm was not found on this computer. Install Node.js, which brings npm, or use Install from a folder…')
    expect(failureLine(missing, ko)).toBe('이 컴퓨터에 npm 이 없습니다. npm 이 함께 오는 Node.js 를 설치하거나, 폴더에서 설치… 를 쓰세요.')
  })

  // Plugins 2e-2 (the user's decision 2026-10-13): a network that blocks the fetch of Astera's npm gets its own notice.
  it('says which of the three kept Astera from its own npm, a blocking network in so many words', () => {
    const f = (code: string, message = 'x', reason?: string) => ({ ok: false as const, code, message, ...(reason !== undefined ? { reason } : {}) })
    // With what the Host found, so a person and an administrator can tell DNS from a proxy's sign-in (2e-2 final review M1).
    expect(failureLine(f('PLUGIN_NPM_BLOCKED', 'x', 'Failed to establish tunnel: 407 Proxy Authentication Required'), ko)).toBe(
      'Astera 가 npm 을 받아 오지 못했습니다. registry.npmjs.org 에 닿지 못했거나 거절당했습니다(Failed to establish tunnel: 407 Proxy Authentication Required). 회사망, 방화벽, 프록시가 막고 있을 수 있습니다. 네트워크 관리자에게 registry.npmjs.org 접근을 요청하거나, Node.js 를 설치하거나, 폴더에서 설치… 를 쓰세요.'
    )
    expect(failureLine(f('PLUGIN_NPM_BLOCKED', 'x', 'ENOTFOUND'), en)).toBe(
      'Astera could not fetch npm: registry.npmjs.org could not be reached or refused it (ENOTFOUND). A company network, a firewall or a proxy may block it. Ask your network administrator for access to registry.npmjs.org, install Node.js, or use Install from a folder.'
    )
    expect(failureLine(f('PLUGIN_NPM_ALTERED'), en)).toBe(
      'The npm Astera fetched is not the real one, so it was not used: something on the network, such as a security appliance or a sign-in page, may have changed it. Install Node.js, or use Install from a folder.'
    )
    expect(failureLine(f('PLUGIN_NPM_FETCH_FAILED', 'disk full'), en)).toBe('Astera could not set npm up. Install Node.js, or use Install from a folder. (disk full)')
    // Found on the dev app: the Host's sentence repeated the advice in English; only its reason is kept, as the Host
    // sends it on its own (2e-2 final review M1, rather than read out of the sentence).
    expect(failureLine(f('PLUGIN_NPM_FETCH_FAILED', 'npm is not installed, and Astera could not set up ...', "EEXIST: file already exists, mkdir 'C:/p'"), en)).toBe(
      "Astera could not set npm up. Install Node.js, or use Install from a folder. (EEXIST: file already exists, mkdir 'C:/p')"
    )
  })

  it('keeps a notice under the package row for what kept npm away, and for nothing else', () => {
    for (const code of ['PLUGIN_NPM_BLOCKED', 'PLUGIN_NPM_ALTERED', 'PLUGIN_NPM_FETCH_FAILED', 'PLUGIN_NPM_MISSING'])
      expect(npmNotice({ ok: false, code, message: 'x' }), code).toBe(true)
    for (const code of ['NOT_FOUND', 'CONFLICT', 'HOST_NOT_RUNNING', 'FAILED']) expect(npmNotice({ ok: false, code, message: 'x' }), code).toBe(false)
  })

  it('gives the Host’s own sentence otherwise', () => {
    expect(failureLine({ ok: false, code: 'CONFLICT', message: 'D:/x changed since it was shown' }, en)).toBe('D:/x changed since it was shown')
  })
})

// 2d final review M4: the one conflict an install has is the folder changing under the warning (manager.ts installable).
describe('installFailureLine', () => {
  it('says in the app’s words that the folder changed and nothing was installed', () => {
    const changed = { ok: false as const, code: 'CONFLICT', message: 'the folder changed after it was shown: it now holds x@1.0.1; run the install again' }
    expect(installFailureLine(changed, en)).toBe('The folder changed after the warning was shown, so nothing was installed. Install it again.')
    expect(installFailureLine(changed, ko)).toBe('경고를 보여 준 뒤 폴더가 바뀌어 아무것도 설치하지 않았습니다. 다시 설치하세요.')
    expect(installFailureLine({ ok: false, code: 'HOST_NOT_RUNNING', message: 'x' }, en)).toBe('The app is not connected to the Host.')
  })
})

// Plugin API 2 (ADR-008): the trust level is said wherever a plugin is installed or listed
describe('the trust level in Settings', () => {
  it('names the UI permissions, the ready status and both trust levels', () => {
    for (const p of ['commands.register', 'panels.register', 'workspace.read']) {
      expect(permissionLabel(p, en), p).not.toBe(p)
      expect(permissionLabel(p, ko), p).not.toBe(p)
    }
    expect(statusLabel('ready', en)).toBe('Ready')
    expect(trustLabel('trusted', en)).toBe('Trusted code')
    expect(trustLabel('restricted-ui', en)).toBe('Restricted UI')
    // An answer from a Host without the field: the plugin is a trusted one, as every API 1 plugin is
    expect(trustLabel(undefined, en)).toBe('Trusted code')
  })

  it('ends a UI-only plugin’s install prompt with the restricted UI notice, never the trusted code warning', () => {
    const ui = installPrompt({ ...INSPECTION, trust: 'restricted-ui', permissions: ['panels.register'] }, 'D:/work/hello', en)
    expect(ui.footer).toContain(en('settings.plugins.install.restrictedUi'))
    expect(ui.footer).not.toContain(en('settings.plugins.install.trust'))
    const both = installPrompt({ ...INSPECTION, trust: 'trusted' }, 'D:/work/both', en)
    expect(both.footer).toContain(en('settings.plugins.install.trust'))
  })
})
