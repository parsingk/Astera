import { describe, it, expect } from 'vitest'
import { hostFeatures } from './features'
import { HOST_FEATURE_BLOCKS, HOST_FEATURE_CHAT_TAKEOVER, HOST_FEATURE_COORDINATOR_IDLE, HOST_FEATURE_DISPATCH, HOST_FEATURE_DRIVER, HOST_FEATURE_JOURNAL, HOST_FEATURE_MCP_HTTP, HOST_FEATURE_RECOVERY, HOST_FEATURE_REMOTE, HOST_FEATURE_ROLLING, HOST_FEATURE_ROLL_JOURNAL, HOST_FEATURE_SLACK_OWNER, HOST_FEATURE_SPAWN, HOST_FEATURE_UNDERSTANDING, HOST_FEATURE_WORKSPACE, HOST_FEATURE_WORKSPACE_SIZE, HOST_FEATURE_WORK_UNITS, HOST_FEATURE_WORKTREES } from '../core/host/protocol'

describe('hostFeatures (R17)', () => {
  it('announces spawn, worktrees, dispatch, rolling, blocks and roll-journal together, or none of them', () => {
    expect(hostFeatures({ spawns: true })).toEqual([
      HOST_FEATURE_SPAWN,
      HOST_FEATURE_WORKTREES,
      HOST_FEATURE_DISPATCH,
      HOST_FEATURE_DRIVER,
      HOST_FEATURE_ROLLING,
      HOST_FEATURE_BLOCKS,
      HOST_FEATURE_ROLL_JOURNAL,
      HOST_FEATURE_CHAT_TAKEOVER,
      HOST_FEATURE_WORK_UNITS,
      HOST_FEATURE_RECOVERY,
      HOST_FEATURE_COORDINATOR_IDLE,
      HOST_FEATURE_JOURNAL,
      HOST_FEATURE_UNDERSTANDING,
      HOST_FEATURE_MCP_HTTP,
      HOST_FEATURE_REMOTE
    ])
    // coordinator-idle rides no spawner (final round 3): every Host serves the CLI's check --wait.
    expect(hostFeatures({ spawns: false })).toEqual([HOST_FEATURE_COORDINATOR_IDLE, HOST_FEATURE_JOURNAL, HOST_FEATURE_UNDERSTANDING, HOST_FEATURE_MCP_HTTP, HOST_FEATURE_REMOTE])
  })
  // Remote runtime design §2.6: recovery starts workers, so only a Host that starts them recovers.
  it('announces recovery only with a spawner', () => {
    expect(hostFeatures({ spawns: true })).toContain(HOST_FEATURE_RECOVERY)
    expect(hostFeatures({ spawns: false })).not.toContain(HOST_FEATURE_RECOVERY)
  })
  // Limits L3: the driver report comes from the driving, which exists exactly with a spawner.
  it('announces driver exactly with dispatch', () => {
    expect(hostFeatures({ spawns: true })).toContain(HOST_FEATURE_DRIVER)
    expect(hostFeatures({ spawns: false })).not.toContain(HOST_FEATURE_DRIVER)
  })
  it('announces chat-takeover exactly with rolling', () => {
    expect(hostFeatures({ spawns: true })).toContain(HOST_FEATURE_CHAT_TAKEOVER)
    expect(hostFeatures({ spawns: false })).not.toContain(HOST_FEATURE_CHAT_TAKEOVER)
  })

  // MCP HTTP §3 (Ruling 2): every Host supervises the entrance, and one without CLI paths answers its state as failed.
  it('announces mcp-http with or without a spawner, and the SDK or the workspace', () => {
    expect(HOST_FEATURE_MCP_HTTP).toBe('mcp-http')
    for (const a of [{ spawns: true, slack: true, workspace: true }, { spawns: false }]) expect(hostFeatures(a)).toContain(HOST_FEATURE_MCP_HTTP)
  })

  // Host journal P6: every Host commits, so every Host journals.
  it('announces journal with or without a spawner', () => {
    expect(hostFeatures({ spawns: true })).toContain(HOST_FEATURE_JOURNAL)
    expect(hostFeatures({ spawns: false })).toContain(HOST_FEATURE_JOURNAL)
  })

  // How It Works in the Host (E1 §2): every Host commits, so every Host can record a finished Run.
  it('announces understanding with or without a spawner', () => {
    expect(hostFeatures({ spawns: true })).toContain(HOST_FEATURE_UNDERSTANDING)
    expect(hostFeatures({ spawns: false })).toContain(HOST_FEATURE_UNDERSTANDING)
  })

  // E2 §3: a Host that cannot start sessions has none to watch, so work-units rides the spawner, as worktrees does.
  it('announces work-units only with a spawner', () => {
    expect(hostFeatures({ spawns: true })).toContain(HOST_FEATURE_WORK_UNITS)
    expect(hostFeatures({ spawns: false })).not.toContain(HOST_FEATURE_WORK_UNITS)
  })

  it('announces slack-owner only with a spawner and a loaded SDK (Slack in the Host, P1)', () => {
    expect(hostFeatures({ spawns: true, slack: true })).toContain(HOST_FEATURE_SLACK_OWNER)
    expect(hostFeatures({ spawns: true, slack: false })).not.toContain(HOST_FEATURE_SLACK_OWNER)
    expect(hostFeatures({ spawns: false, slack: true })).not.toContain(HOST_FEATURE_SLACK_OWNER)
    expect(hostFeatures({ spawns: true })).not.toContain(HOST_FEATURE_SLACK_OWNER)
  })

  it('announces workspace only when asked, with or without a spawner (agent workspace design)', () => {
    expect(hostFeatures({ spawns: false, workspace: true })).toContain(HOST_FEATURE_WORKSPACE)
    expect(hostFeatures({ spawns: true, workspace: true })).toContain(HOST_FEATURE_WORKSPACE)
    expect(hostFeatures({ spawns: true })).not.toContain(HOST_FEATURE_WORKSPACE)
    // The mirror tab's size rides the workspace: a Host with one sizes its app windows.
    expect(hostFeatures({ spawns: false, workspace: true })).toContain(HOST_FEATURE_WORKSPACE_SIZE)
    expect(hostFeatures({ spawns: true })).not.toContain(HOST_FEATURE_WORKSPACE_SIZE)
  })
})
