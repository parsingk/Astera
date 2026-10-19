// G8 demo: the Run detail is the App's, the snapshot it draws from is the Jobs view's. Leaving the Jobs view clears the
// snapshot (App's subscription effect), so the effect that closes a detail whose Run is gone must close it then too,
// before it steps over a null snapshot. Read from the source, as folderLink.wiring.test reads the App's other wiring.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8')

describe('the Run detail is wired to the Jobs view being on screen', () => {
  it('closes the detail when the Jobs view leaves, before the null-snapshot guard, and reacts to both', () => {
    const close = app.indexOf('if (detailOffScreen({ jobsOpen, sidebarOpen })) {')
    const guard = app.indexOf('|| snap === null) return', close)
    expect(close).toBeGreaterThan(0)
    expect(guard).toBeGreaterThan(close)
    expect(app.slice(close, guard)).toContain('setOpenRun(null)')
    expect(app.slice(guard, guard + 900)).toContain('}, [openRun, currentProject, orchSnapshot, remoteSnapshot, jobsOpen, sidebarOpen])')
  })
})
