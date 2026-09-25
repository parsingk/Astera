import { describe, it, expect } from 'vitest'
import { hostFeatures } from './features'
import { HOST_FEATURE_BLOCKS, HOST_FEATURE_DISPATCH, HOST_FEATURE_ROLLING, HOST_FEATURE_SPAWN, HOST_FEATURE_WORKTREES } from '../core/host/protocol'

describe('hostFeatures (R17)', () => {
  it('announces spawn, worktrees, dispatch, rolling and blocks together, or none of them', () => {
    expect(hostFeatures({ spawns: true })).toEqual([
      HOST_FEATURE_SPAWN,
      HOST_FEATURE_WORKTREES,
      HOST_FEATURE_DISPATCH,
      HOST_FEATURE_ROLLING,
      HOST_FEATURE_BLOCKS
    ])
    expect(hostFeatures({ spawns: false })).toEqual([])
  })
})
