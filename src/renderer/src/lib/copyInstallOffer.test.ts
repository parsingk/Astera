import { describe, expect, it } from 'vitest'
import { offerCopyInstall, type CopyInstallOfferDeps } from './copyInstallOffer'

type Pushed = { message: string; label?: string; onClick?: () => void }

function fakes(over: Partial<CopyInstallOfferDeps> = {}) {
  const infos: Pushed[] = []
  const errors: string[] = []
  const dismissed: number[] = []
  const calls: string[] = []
  const deps: CopyInstallOfferDeps = {
    copyLocation: async () => '/c/astera-updater/manual/1.5.5/Astera.app',
    installCopy: async () => (calls.push('install'), { ok: true }),
    confirm: async () => (calls.push('confirm'), true),
    quit: () => void calls.push('quit'),
    t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key),
    info: (message, options) => (infos.push({ message, label: options.action.label, onClick: options.action.onClick }), 7),
    error: (message) => void errors.push(message),
    dismiss: (id) => void dismissed.push(id),
    ...over
  }
  return { deps, infos, errors, dismissed, calls }
}

/** The action's onClick returns nothing; what it starts is awaited here by letting the queued promises run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('offerCopyInstall', () => {
  it('says nothing when the app does not run from a manual-install copy', async () => {
    const f = fakes({ copyLocation: async () => null })
    await offerCopyInstall(f.deps)
    expect(f.infos).toEqual([])
  })

  it('says the app runs from the update cache and offers the move', async () => {
    const f = fakes()
    await offerCopyInstall(f.deps)
    expect(f.infos).toEqual([expect.objectContaining({ message: 'update.copy.running', label: 'update.copy.move' })])
  })

  it('asks first, installs, then quits so the installed copy starts', async () => {
    const f = fakes()
    await offerCopyInstall(f.deps)
    f.infos[0].onClick?.()
    await settle()
    expect(f.dismissed).toEqual([7])
    expect(f.calls).toEqual(['confirm', 'install', 'quit'])
  })

  it('installs nothing when the person declines', async () => {
    const f = fakes({ confirm: async () => false })
    await offerCopyInstall(f.deps)
    f.infos[0].onClick?.()
    await settle()
    expect(f.calls).toEqual([])
  })

  it('says why the move failed and keeps running', async () => {
    const f = fakes({ installCopy: async () => ({ ok: false, message: 'Permission denied' }) })
    await offerCopyInstall(f.deps)
    f.infos[0].onClick?.()
    await settle()
    expect(f.errors).toEqual(['update.copy.failed{"message":"Permission denied"}'])
    expect(f.calls).toEqual(['confirm'])
  })

  it('treats a failed question to main as no copy', async () => {
    const f = fakes({ copyLocation: () => Promise.reject(new Error('No handler registered')) })
    await offerCopyInstall(f.deps)
    expect(f.infos).toEqual([])
  })
})
