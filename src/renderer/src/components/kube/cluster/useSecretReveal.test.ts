import { describe, it, expect } from 'vitest'
import { createRevealGate } from './useSecretReveal'
import type { Read, SecretValue } from '../../../../../core/kube/cluster/types'

const values: SecretValue[] = [{ key: 'p', text: 'hunter2', base64: 'aHVudGVyMg==' }]
type Answer = Read<{ values: SecretValue[] }>

function deferred(): { promise: Promise<Answer>; resolve(a: Answer): void } {
  let resolve!: (a: Answer) => void
  const promise = new Promise<Answer>((r) => (resolve = r))
  return { promise, resolve }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const noFail = (): void => {}

// Spec D6: revealed values live only while that Secret's reveal holds. The gate decides which reveal answer may be kept.
describe('createRevealGate', () => {
  it('keeps the answer of the current request, tied to the object and its version', async () => {
    const held: unknown[] = []
    const gate = createRevealGate((r) => void held.push(r), noFail)
    gate.request('u1', '7', async () => ({ ok: true, values }))
    await settle()
    expect(held).toEqual([{ uid: 'u1', version: '7', values }])
  })

  // Final review T12: the ticket guards a reveal answer that arrives after "hide".
  it('drops an answer that arrives after hide', async () => {
    const held: unknown[] = []
    const gate = createRevealGate((r) => void held.push(r), noFail)
    const answer = deferred()
    gate.request('u1', '7', () => answer.promise)
    gate.drop()
    answer.resolve({ ok: true, values })
    await settle()
    expect(held).toEqual([null])
    expect(JSON.stringify(held)).not.toContain('hunter2')
  })

  it('drops the answer of an older request that comes last', async () => {
    const held: unknown[] = []
    const gate = createRevealGate((r) => void held.push(r), noFail)
    const first = deferred()
    const second = deferred()
    gate.request('u1', '7', () => first.promise)
    gate.request('u1', '8', () => second.promise)
    second.resolve({ ok: true, values })
    first.resolve({ ok: true, values: [{ key: 'p', text: 'older', base64: 'b2xkZXI=' }] })
    await settle()
    expect(held).toEqual([{ uid: 'u1', version: '8', values }])
  })

  // Final review T14: a Secret that changed in the cluster (or another object) lets go of the plaintext, not only hides it.
  it('lets go of the values on drop, and of an answer still on its way', async () => {
    const held: unknown[] = []
    const gate = createRevealGate((r) => void held.push(r), noFail)
    gate.request('u1', '7', async () => ({ ok: true, values }))
    await settle()
    gate.drop()
    expect(held.at(-1)).toBeNull()
    const late = deferred()
    gate.request('u1', '8', () => late.promise)
    gate.drop()
    late.resolve({ ok: true, values })
    await settle()
    expect(held.at(-1)).toBeNull()
  })

  it('keeps nothing from a failed reveal', async () => {
    const held: unknown[] = []
    const gate = createRevealGate((r) => void held.push(r), noFail)
    gate.request('u1', '7', async () => ({ ok: false, message: 'Forbidden' }))
    gate.request('u1', '7', () => Promise.reject(new Error('ipc')))
    await settle()
    expect(held).toEqual([])
  })

  // Task 12 minor: a failed "show values" showed nothing at all. The failure is reported for its object, and goes on the
  // next try, on hide and when the object changes.
  it('reports a failed reveal for its object, and clears it on the next try and on drop', async () => {
    const failures: unknown[] = []
    const gate = createRevealGate(() => {}, (f) => void failures.push(f))
    gate.request('u1', '7', async () => ({ ok: false, message: 'Error from server (Forbidden): secrets "s" is forbidden' }))
    await settle()
    expect(failures).toEqual([null, { uid: 'u1', message: 'Error from server (Forbidden): secrets "s" is forbidden' }])
    gate.request('u1', '7', () => Promise.reject(new Error('ipc closed')))
    expect(failures.at(-1)).toBeNull()
    await settle()
    expect(failures.at(-1)).toEqual({ uid: 'u1', message: 'ipc closed' })
    gate.drop()
    expect(failures.at(-1)).toBeNull()
  })

  it('reports nothing for a failure that answers after hide or a newer request', async () => {
    const failures: unknown[] = []
    const gate = createRevealGate(() => {}, (f) => void failures.push(f))
    const first = deferred()
    gate.request('u1', '7', () => first.promise)
    gate.drop()
    first.resolve({ ok: false, message: 'late' })
    await settle()
    expect(failures.filter((f) => f !== null)).toEqual([])
  })
})
