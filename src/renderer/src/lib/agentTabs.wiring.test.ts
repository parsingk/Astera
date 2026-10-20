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
    expect(onExit).toContain('if (!closesWhenEnded(sessionsRef.current.find((s) => s.id === sessionId), { afterLostSight: true })) return')
    expect(onExit).toContain('closeWorkbenchTabRef.current(tab)')
  })

  // Review M5: a lost-sight exit is looked at again after the longer wait, closing only if the Host did not hand it back
  it('a lost-sight exit is looked at again after the longer wait', () => {
    const onExit = between("window.api.on('session:exit'", '\n    })\n')
    expect(onExit).toContain('exitCode === PTY_LOST_SIGHT_EXIT_CODE ? AGENT_TAB_LOST_SIGHT_CLOSE_MS : AGENT_TAB_CLOSE_DELAY_MS')
    expect(onExit).toContain('{ afterLostSight: true }')
  })

  // Review M4: closing the tab a person is looking at holds the activation focus, so the tab beside it does not take it
  it('closing the tab a person is looking at holds the activation focus', () => {
    const onExit = between("window.api.on('session:exit'", '\n    })\n')
    expect(onExit).toContain('leafOf(layoutRef.current, activePaneIdRef.current)?.activeTabId === tab')
    expect(onExit).toContain('holdActivationFocus()')
  })

  // Review I1: a Host chat roll reports itself once the new process started, after the old session's exit closed its
  // tab; the new session then gets a tab of its own, as session:created places one
  it('a roll whose old tab already closed places the new session as a background tab', () => {
    const onRolled = between("window.api.on('session:rolled'", 'sessionBus.discard(oldSessionId)')
    expect(onRolled).toContain('if (!sessionsRef.current.some((s) => s.id === oldSessionId)) {')
    expect(onRolled).toContain('place(layoutRef.current, info.id, null, null, true)')
  })

  it('a pending look is cleared with the listeners', () => {
    const cleanup = between('      offExit()\n', '  }, [])')
    expect(cleanup).toContain('for (const timer of endedTimers) clearTimeout(timer)')
  })

  it('a reload does not bring an ended agent’s session back as a tab', () => {
    const reload = between('void window.api.sessions.list().then(', 'setSessions(list)')
    expect(reload).toContain('.filter((s) => !closesWhenEnded(s, { afterLostSight: true }))')
  })
})

// Review M4: every terminal that takes focus as its tab activates asks the hold first
describe('terminals respect the activation focus hold', () => {
  const component = (f: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'components', f), 'utf8')
  it.each(['TerminalView.tsx', 'TerminalBody.tsx', 'RemoteTerminalView.tsx'])('%s', (f) => {
    expect(component(f)).toMatch(/if \(active[^)]*&& !activationFocusHeld\(\)\) termRef\.current\?\.focus\(\)/)
  })
})
