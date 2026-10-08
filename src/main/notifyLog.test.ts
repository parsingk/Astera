// A desktop notification leaves one line in notifications.log (shown, or refused by the OS), so "I got no
// notification" can be answered from the profile, and a check can see that one fired.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('desktop notifications are logged', () => {
  it('index.ts writes a line when one is shown and when the OS refuses it', () => {
    const index = readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
    expect(index).toContain("lineLog(path.join(app.getPath('userData'), 'notifications.log'))")
    const show = index.slice(index.indexOf('const desktop = new DesktopNotifier({'), index.indexOf('const desktop = new DesktopNotifier({') + 3000)
    expect(show).toMatch(/notifyLog\(`shown /)
    expect(show).toMatch(/notifyLog\(`not shown/)
  })
})
