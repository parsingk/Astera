import { describe, it, expect } from 'vitest'
import { WORKSPACE_FEATURES_DEFAULTS, readWorkspaceFeatures, writableWorkspaceFeatures } from './workspaceFeatures'

describe('workspace feature switches', () => {
  it('are all on by default', () => {
    expect(WORKSPACE_FEATURES_DEFAULTS).toEqual({ layoutMemory: true, problemsTab: true, contextBridge: true, testsTab: true, languageServers: true })
  })

  it('read as the defaults from anything that is not an object', () => {
    for (const v of [undefined, null, [], 'x', 3]) expect(readWorkspaceFeatures(v)).toEqual(WORKSPACE_FEATURES_DEFAULTS)
  })

  it('turn one off only on an explicit false', () => {
    expect(readWorkspaceFeatures({ problemsTab: false })).toEqual({ layoutMemory: true, problemsTab: false, contextBridge: true, testsTab: true, languageServers: true })
    // Phase 3 Part 2: the Tests tab, on unless turned off
    expect(readWorkspaceFeatures({ testsTab: false }).testsTab).toBe(false)
    expect(readWorkspaceFeatures({ languageServers: false }).languageServers).toBe(false)
  })

  // A hand-edited file: 'no' and 0 are not an explicit false, so the feature stays on
  it('stay on for values that are not an explicit false', () => {
    expect(readWorkspaceFeatures({ layoutMemory: 'no', contextBridge: 0, problemsTab: null })).toEqual(WORKSPACE_FEATURES_DEFAULTS)
  })

  it('are left out of the file while every switch is at its default', () => {
    expect(writableWorkspaceFeatures(WORKSPACE_FEATURES_DEFAULTS)).toBeUndefined()
    expect(writableWorkspaceFeatures({ ...WORKSPACE_FEATURES_DEFAULTS, layoutMemory: false })).toEqual({
      layoutMemory: false,
      problemsTab: true,
      contextBridge: true,
      testsTab: true,
      languageServers: true
    })
  })
})
