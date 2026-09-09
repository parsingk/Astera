import { describe, it, expect } from 'vitest'
import { quitConfirmBody } from './quitConfirm'

describe('quitConfirmBody', () => {
  it('says everything ends when the app owns every running session', () => {
    expect(quitConfirmBody(3, 0)).toEqual({ key: 'common.quitConfirm.body', params: { count: 3 } })
  })

  it('says everything comes back when the Host owns every running session', () => {
    expect(quitConfirmBody(3, 3)).toEqual({ key: 'common.quitConfirm.bodyKept', params: { count: 3 } })
  })

  // The Host takes a moment to start, so a session spawned at boot can be the app's own child while
  // the rest belong to the Host. Both of the old sentences are wrong then, each about half the
  // sessions, and the half that is wrong is the half the person would have wanted to know about.
  it('names both halves when some sessions survive the quit and some do not', () => {
    expect(quitConfirmBody(3, 1)).toEqual({ key: 'common.quitConfirm.bodyMixed', params: { kept: 1, ended: 2 } })
  })

  // The two numbers are taken at different moments from different processes: the count is the
  // renderer's last render, the kept figure is main's answer at click time. A session spawned in
  // between makes kept the larger of the two, and subtracting would promise a negative number of
  // terminated sessions.
  it('reads a kept count larger than the running count as all of them kept', () => {
    expect(quitConfirmBody(2, 3)).toEqual({ key: 'common.quitConfirm.bodyKept', params: { count: 2 } })
  })
})
