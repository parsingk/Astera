// Phase 9b review M6: a select a form cannot use right now (a read-only pairing's account and folder, the Runtime while
// a session is starting) is shown disabled, not left to open and change something that will not be used.
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Select } from './Select'

vi.mock('../i18n/I18nProvider', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

const items = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]

describe('Select disabled', () => {
  it('disables its trigger', () => {
    const html = renderToString(createElement(Select, { items, value: 'a', onChange: () => {}, disabled: true }))
    expect(html).toMatch(/<button[^>]*class="sel-trigger"[^>]*disabled=""/)
  })
  it('is enabled by default', () => {
    const html = renderToString(createElement(Select, { items, value: 'a', onChange: () => {} }))
    expect(html).not.toContain('disabled=""')
  })
})
