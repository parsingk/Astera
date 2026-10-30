// A finding carries its reason and action both as a Message, for the app to word in the person's language, and in
// English, for the CLI and --json (plan Global Constraints, Text).
import { describe, it, expect } from 'vitest'
import { finding, findingKey } from './make'

describe('finding', () => {
  it("reason and action are the English catalog's words with the params filled", () => {
    const f = finding({
      rule: 'unused-profile',
      subject: { kind: 'profile', id: 'ap_1', name: 'Reviewer' },
      message: { key: 'findings.reason.unusedProfile', params: { days: 91 } },
      suggestion: { key: 'findings.do.archiveProfile' },
      open: { kind: 'profiles', profileIds: ['ap_1'] },
      profileIds: ['ap_1']
    })
    expect(f).toEqual({
      key: 'unused-profile:ap_1',
      rule: 'unused-profile',
      subject: { kind: 'profile', id: 'ap_1', name: 'Reviewer' },
      profileIds: ['ap_1'],
      message: { key: 'findings.reason.unusedProfile', params: { days: 91 } },
      reason: 'Not used in 91 days.',
      suggestion: { key: 'findings.do.archiveProfile' },
      action: 'Archive the profile.',
      open: { kind: 'profiles', profileIds: ['ap_1'] },
      ignored: false
    })

    // Two reasons in one finding: each is worded where it is put in
    const both = finding({
      rule: 'broken-reference',
      subject: { kind: 'profile', id: 'ap_1', name: 'Reviewer' },
      message: {
        key: 'findings.reason.pair',
        params: {
          first: { key: 'findings.reason.removedAccount', params: { ids: 'acc_9' } },
          second: { key: 'findings.reason.removedMcp', params: { ids: 'ext_1, ext_2' } }
        }
      },
      suggestion: { key: 'findings.do.editProfile' },
      open: { kind: 'profiles', profileIds: ['ap_1'] }
    })
    expect(both.reason).toBe('Uses an account that was removed: acc_9. Leaves out an MCP server that was removed: ext_1, ext_2.')
    expect(both.action).toBe('Edit the profile.')
    expect(both.profileIds).toEqual([])
    expect(both).not.toHaveProperty('part')
  })

  it('keys by rule and subject, and by part where there is one (spec §6)', () => {
    expect(findingKey('token-spike', 'run_1')).toBe('token-spike:run_1')
    expect(findingKey('over-broad-profile', 'ap_1', 'mcp:ext_1')).toBe('over-broad-profile:ap_1:mcp:ext_1')
    const f = finding({
      rule: 'over-broad-profile',
      subject: { kind: 'profile', id: 'ap_1', name: 'Reviewer' },
      message: { key: 'findings.reason.unusedProfile', params: { days: 1 } },
      suggestion: { key: 'findings.do.editProfile' },
      open: { kind: 'profiles', profileIds: ['ap_1'] },
      part: 'bypass'
    })
    expect(f.key).toBe('over-broad-profile:ap_1:bypass')
    expect(f.part).toBe('bypass')
  })
})
