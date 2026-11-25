import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { t as translate, type MessageKey, type MessageParams } from '../../../core/i18n'
import type { SettingField } from '../../../core/plugins/settings'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: MessageKey, params?: MessageParams) => translate('en', key, params), tm: (m: unknown) => String(m) })
}))

const { PluginCard, PluginLogs, PluginSettingsForm } = await import('./PluginsSettings')

const PLUGIN = {
  id: '@acme/astera-jira',
  name: '@acme/astera-jira',
  displayName: 'Jira',
  version: '1.0.0',
  enabled: true,
  status: 'running',
  capabilities: [],
  permissions: ['jobs.read', 'jobs.create'],
  requested: ['jobs.read', 'jobs.create', 'events.subscribe']
}
const noop = (): void => {}
const card = (plugin: Record<string, unknown>): string =>
  renderToStaticMarkup(
    React.createElement(PluginCard, { plugin, busy: false, onConfigure: noop, onToggle: noop, onStartAgain: noop, onRemove: noop, onLogs: noop })
  )
const buttons = (html: string): string[] => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])

describe('PluginCard (spec §30)', () => {
  it('shows the name, status, id and version, and the permissions granted in words', () => {
    const html = card(PLUGIN)
    for (const text of ['Jira', 'Running', '@acme/astera-jira', 'Version 1.0.0', 'Read Jobs', 'Create Jobs']) expect(html, text).toContain(text)
    // What the manifest asked for and was not granted is not listed as granted.
    expect(html).not.toContain('Subscribe to events')
    expect(html).not.toContain('Capabilities')
    expect(buttons(html)).toEqual(['Configure', 'Disable', 'Logs', 'Remove'])
  })

  it('says why a plugin does not run, and what it serves', () => {
    const html = card({ ...PLUGIN, status: 'stopped', reason: 'needs settings: token; set them with astera plugins configure --id x', capabilities: ['job-source'] })
    expect(html).toContain('Stopped')
    expect(html).toContain('Needs settings: token. Set them with Configure.')
    expect(html).toContain('Capabilities')
    expect(html).toContain('job-source')
  })

  it('offers Enable for a disabled plugin, and Start again for a failed one', () => {
    expect(buttons(card({ ...PLUGIN, enabled: false, status: 'disabled' }))).toEqual(['Configure', 'Enable', 'Logs', 'Remove'])
    expect(buttons(card({ ...PLUGIN, status: 'failed', reason: 'activate threw: x' }))).toEqual(['Configure', 'Start again', 'Disable', 'Logs', 'Remove'])
  })

  // 2d final review I1: while a change runs (an install included), every button of the card waits, Logs too: its read
  // would wait behind the change in the Host.
  it('makes every button wait while a change is in flight', () => {
    const html = renderToStaticMarkup(
      React.createElement(PluginCard, { plugin: PLUGIN, busy: true, onConfigure: noop, onToggle: noop, onStartAgain: noop, onRemove: noop, onLogs: noop })
    )
    const all = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0])
    expect(all).toHaveLength(4)
    for (const b of all) expect(b).toContain('disabled=""')
  })

  it('says a plugin was granted nothing', () => {
    expect(card({ ...PLUGIN, permissions: [] })).toContain('No permissions')
  })
})

describe('PluginSettingsForm (spec §23, §24)', () => {
  const fields: SettingField[] = [
    { key: 'baseUrl', type: 'string', title: 'Base URL', description: 'Where Jira answers', required: true },
    { key: 'dryRun', type: 'boolean', default: false, required: false },
    { key: 'pageSize', type: 'integer', default: 50, enum: [25, 50, 100], required: false },
    { key: 'token', type: 'string', secret: true, required: true },
    { key: 'spare', type: 'string', secret: true, required: false }
  ]
  const form = (over: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      React.createElement(PluginSettingsForm, {
        fields,
        values: { baseUrl: 'https://a.example.com', dryRun: true },
        secrets: { token: 'set', spare: 'unset' },
        draft: {},
        clear: new Set<string>(),
        onDraft: noop,
        onClear: noop,
        onSave: noop,
        saving: false,
        changed: false,
        ...over
      })
    )

  it('shows each plain value, its title and description, and which are required', () => {
    const html = form()
    expect(html).toContain('Base URL')
    expect(html).toContain('Where Jira answers')
    expect(html).toContain('value="https://a.example.com"')
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/)
    expect(html.match(/required/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('shows a secret only as set or not set, in an empty password box, with Clear only when it is set', () => {
    const html = form()
    const secretBoxes = [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map((m) => m[0])
    expect(secretBoxes).toHaveLength(2)
    for (const box of secretBoxes) expect(box).not.toMatch(/value="[^"]+"/)
    expect(html).toContain('>set<')
    expect(html).toContain('>not set<')
    expect(html.match(/Clear/g)).toHaveLength(1)
  })

  // Found on the dev app: an empty box for a secret not set yet said "to change it".
  it('asks for a secret not set yet, and for a new value of one that is', () => {
    const html = form()
    expect(html).toContain('placeholder="Type a new value to change it"')
    expect(html).toContain('placeholder="Type the value"')
  })

  it('shows what the person typed over what is stored, and saves only when something changed', () => {
    const html = form({ draft: { baseUrl: 'https://b.example.com' }, changed: true })
    expect(html).toContain('value="https://b.example.com"')
    expect(html).toMatch(/<button[^>]*>Save<\/button>/)
    expect(form()).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/)
  })

  // 2d final review M2: a save restarts a running plugin, and what is typed meanwhile would be lost with its answer.
  it('holds every field while it saves', () => {
    expect(form({ saving: true })).toMatch(/<fieldset[^>]*disabled=""/)
    expect(form()).not.toMatch(/<fieldset[^>]*disabled=""/)
  })

  // 2d final review M6: choosing no value for a choice that has a default leaves the default, and says so.
  it('names the empty choice by the default it leaves', () => {
    expect(form({ draft: { pageSize: '' } })).toContain('default 50')
  })

  it('says a plugin has no settings', () => {
    expect(renderToStaticMarkup(React.createElement(PluginSettingsForm, { ...{ fields: [], values: {}, secrets: {}, draft: {}, clear: new Set<string>(), onDraft: noop, onClear: noop, onSave: noop, saving: false, changed: false } }))).toContain(
      'This plugin has no settings.'
    )
  })
})

describe('PluginLogs', () => {
  it('shows the lines in order, and says when there is none', () => {
    const html = renderToStaticMarkup(React.createElement(PluginLogs, { lines: ['first line', 'second <line>'], onRefresh: noop }))
    expect(html.indexOf('first line')).toBeLessThan(html.indexOf('second &lt;line&gt;'))
    expect(renderToStaticMarkup(React.createElement(PluginLogs, { lines: [], onRefresh: noop }))).toContain('No log yet.')
  })
})

describe('PluginCard trust level (ADR-008)', () => {
  it('says a UI-only plugin is restricted UI, ready, and a plugin with code is trusted code', () => {
    const ui = card({ ...PLUGIN, status: 'ready', trust: 'restricted-ui' })
    expect(ui).toContain('Restricted UI')
    expect(ui).toContain('Ready')
    expect(ui).toContain('plugin-trust is-restricted-ui')
    expect(card({ ...PLUGIN, trust: 'trusted' })).toContain('Trusted code')
    expect(card(PLUGIN)).toContain('Trusted code')
  })
})
