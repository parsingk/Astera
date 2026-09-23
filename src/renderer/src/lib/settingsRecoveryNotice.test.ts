import { describe, it, expect } from 'vitest'
import { announceSettingsRecovery, SETTINGS_RECOVERED_KEY } from './settingsRecoveryNotice'

describe('announceSettingsRecovery', () => {
  it('shows the notice when main recovered app-settings.json from a damaged file', async () => {
    const shown: string[] = []
    await announceSettingsRecovery(async () => true, (key) => shown.push(key))
    expect(shown).toEqual([SETTINGS_RECOVERED_KEY])
  })

  it('shows nothing after an ordinary load', async () => {
    const shown: string[] = []
    await announceSettingsRecovery(async () => false, (key) => shown.push(key))
    expect(shown).toEqual([])
  })

  it('shows nothing, and does not throw, when main could not be asked', async () => {
    const shown: string[] = []
    await announceSettingsRecovery(() => Promise.reject(new Error('no handler')), (key) => shown.push(key))
    expect(shown).toEqual([])
  })
})
