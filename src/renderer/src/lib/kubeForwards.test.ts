import { describe, expect, it } from 'vitest'
import { addForward, forwardMessage, forwardRunMs, isLive, reconnectForward, removeForward, stopForward } from './kubeForwards'
import { LOST_POD } from '../../../core/kube/cluster/forward'
import type { ForwardSpec } from '../../../core/kube/cluster/types'

const spec: ForwardSpec = {
  ref: { context: 'c1', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'web-1' },
  local: 8080,
  remote: 80
}
const listening = (forwardId: string) => ({ forwardId, kind: 'listening' as const, local: 8080 })
const exit = (forwardId: string, message: string | null) => ({ forwardId, kind: 'exit' as const, message })

describe('kubeForwards', () => {
  it('starts a row connecting', () => {
    expect(addForward([], 'a', spec)).toEqual([
      { id: 'a', spec, state: 'connecting', reason: null, connectedAt: null, endedAt: null }
    ])
  })

  it('connects on listening', () => {
    const l = forwardMessage(addForward([], 'a', spec), listening('a'), 1000)
    expect(l[0]).toMatchObject({ state: 'connected', connectedAt: 1000, endedAt: null })
  })

  it('turns an ended connected forward disconnected', () => {
    const l = forwardMessage(
      forwardMessage(addForward([], 'a', spec), listening('a'), 1000),
      exit('a', 'error: lost connection to pod'),
      9000
    )
    expect(l[0]).toMatchObject({ state: 'disconnected', reason: LOST_POD, endedAt: 9000, connectedAt: 1000 })
  })

  it('turns a forward that ends before listening failed', () => {
    const l = forwardMessage(addForward([], 'a', spec), exit('a', 'Unable to listen on port 8080'), 500)
    expect(l[0]).toMatchObject({ state: 'failed', reason: 'Unable to listen on port 8080', endedAt: 500, connectedAt: null })
  })

  it('stops a live row and keeps it', () => {
    const l = stopForward(forwardMessage(addForward([], 'a', spec), listening('a'), 1000), 'a', 4000)
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ state: 'stopped', endedAt: 4000, connectedAt: 1000 })
  })

  it('ignores messages for a row that is not live', () => {
    const stopped = stopForward(addForward([], 'a', spec), 'a', 10)
    expect(forwardMessage(stopped, listening('a'), 20)).toEqual(stopped)
    expect(forwardMessage(stopped, exit('a', 'x'), 20)).toEqual(stopped)
    expect(forwardMessage(stopped, exit('zz', 'x'), 20)).toEqual(stopped)
    expect(stopForward(stopped, 'a', 99)).toEqual(stopped)
  })

  it('reconnects an ended row', () => {
    const ended = forwardMessage(
      forwardMessage(addForward([], 'a', spec), listening('a'), 1000),
      exit('a', 'boom'),
      2000
    )
    expect(reconnectForward(ended, 'a')[0]).toEqual({
      id: 'a', spec, state: 'connecting', reason: null, connectedAt: null, endedAt: null
    })
    const live = addForward([], 'a', spec)
    expect(reconnectForward(live, 'a')).toEqual(live)
  })

  it('removes a row', () => {
    expect(removeForward(addForward(addForward([], 'a', spec), 'b', spec), 'a').map((f) => f.id)).toEqual(['b'])
  })

  it('counts how long it ran', () => {
    const connected = forwardMessage(addForward([], 'a', spec), listening('a'), 7000)[0]
    expect(isLive(connected)).toBe(true)
    expect(forwardRunMs(connected, 10000)).toBe(3000)
    const ended = forwardMessage([connected], exit('a', 'x'), 12000)[0]
    expect(forwardRunMs(ended, 12000)).toBe(5000)
    expect(forwardRunMs(ended, 99000)).toBe(5000)
    expect(forwardRunMs(addForward([], 'b', spec)[0], 5000)).toBeNull()
    const failed = forwardMessage(addForward([], 'c', spec), exit('c', 'x'), 5000)[0]
    expect(forwardRunMs(failed, 6000)).toBeNull()
  })
})
