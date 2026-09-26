import { describe, it, expect } from 'vitest'
import { hostFeatures } from './features'
import { HOST_FEATURE_BLOCKS, HOST_FEATURE_CHAT_TAKEOVER, HOST_FEATURE_COORDINATOR_IDLE, HOST_FEATURE_DISPATCH, HOST_FEATURE_ROLLING, HOST_FEATURE_ROLL_JOURNAL, HOST_FEATURE_SLACK_OWNER, HOST_FEATURE_SPAWN, HOST_FEATURE_WORKTREES } from '../core/host/protocol'

describe('hostFeatures (R17)', () => {
  it('announces spawn, worktrees, dispatch, rolling, blocks and roll-journal together, or none of them', () => {
    expect(hostFeatures({ spawns: true })).toEqual([
      HOST_FEATURE_SPAWN,
      HOST_FEATURE_WORKTREES,
      HOST_FEATURE_DISPATCH,
      HOST_FEATURE_ROLLING,
      HOST_FEATURE_BLOCKS,
      HOST_FEATURE_ROLL_JOURNAL,
      HOST_FEATURE_CHAT_TAKEOVER,
      HOST_FEATURE_COORDINATOR_IDLE
    ])
    // coordinator-idle rides no spawner (final round 3): every Host serves the CLI's check --wait.
    expect(hostFeatures({ spawns: false })).toEqual([HOST_FEATURE_COORDINATOR_IDLE])
  })
  it('announces chat-takeover exactly with rolling', () => {
    expect(hostFeatures({ spawns: true })).toContain(HOST_FEATURE_CHAT_TAKEOVER)
    expect(hostFeatures({ spawns: false })).not.toContain(HOST_FEATURE_CHAT_TAKEOVER)
  })

  it('announces slack-owner only with a spawner and a loaded SDK (Slack in the Host, P1)', () => {
    expect(hostFeatures({ spawns: true, slack: true })).toContain(HOST_FEATURE_SLACK_OWNER)
    expect(hostFeatures({ spawns: true, slack: false })).not.toContain(HOST_FEATURE_SLACK_OWNER)
    expect(hostFeatures({ spawns: false, slack: true })).not.toContain(HOST_FEATURE_SLACK_OWNER)
    expect(hostFeatures({ spawns: true })).not.toContain(HOST_FEATURE_SLACK_OWNER)
  })
})
