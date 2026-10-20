// 2026-10-20: a session an agent started closes its tab when it ends (core/sessions/agentTab.ts). The App does it in two
// places, read from the source as folderLink.wiring.test reads the App's other wiring: the exit handler looks again a
// moment after the exit and closes the tab through the same close a person's ✕ takes, and a reload does not bring an
// ended agent's session back as a tab.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8')
const between = (from: string, to: string): string => {
  const start = app.indexOf(from)
  const end = app.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`not found: ${from} … ${to}`)
  return app.slice(start, end)
}

describe('an agent’s session closes its tab when it ends', () => {
  it('the exit handler looks again after the delay and closes the tab as a ✕ does', () => {
    const onExit = between("window.api.on('session:exit'", '\n    })\n')
    expect(onExit).toContain('}, AGENT_TAB_CLOSE_DELAY_MS)')
    expect(onExit).toContain('if (closesWhenEnded(sessionsRef.current.find((s) => s.id === sessionId))) closeWorkbenchTabRef.current(sessionTab(sessionId))')
  })

  it('a pending look is cleared with the listeners', () => {
    const cleanup = between('      offExit()\n', '  }, [])')
    expect(cleanup).toContain('for (const timer of endedTimers) clearTimeout(timer)')
  })

  it('a reload does not bring an ended agent’s session back as a tab', () => {
    const reload = between('void window.api.sessions.list().then(', 'setSessions(list)')
    expect(reload).toContain('.filter((s) => !closesWhenEnded(s))')
  })
})
