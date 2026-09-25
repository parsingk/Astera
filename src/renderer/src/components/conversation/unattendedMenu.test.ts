import { describe, it, expect } from 'vitest'
import { unattendedRows } from './unattendedMenu'

describe('unattendedRows (chat takeover P8)', () => {
  it('offers hold and deny after 60 s, the current one checked', () => {
    const t = (k: string) => k
    expect(unattendedRows('hold', t)).toEqual([
      { key: 'hold', label: 'chat.unattended.hold', checked: true },
      { key: 'deny-after-60s', label: 'chat.unattended.deny60', checked: false }
    ])
    expect(unattendedRows('deny-after-60s', t).map((r) => r.checked)).toEqual([false, true])
  })
})
