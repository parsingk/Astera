import { describe, it, expect } from 'vitest'
import { mcpRefusal, MCP_READ_COMMANDS, MCP_CONTROL_COMMANDS, MCP_SESSION_READ_COMMANDS, MCP_SESSION_WRITE_COMMANDS, MCP_GITHUB_WRITE_COMMANDS } from './mcpGate'

describe('mcpRefusal', () => {
  // Plugin runtime design P5: managing plugins is for this machine's app and CLI; no MCP setting opens it.
  it('refuses every plugins command at every access level', () => {
    for (const cmd of ['plugins-inspect', 'plugins-install', 'plugins-list', 'plugins-get', 'plugins-enable', 'plugins-disable', 'plugins-remove'])
      for (const access of ['read', 'control'] as const) expect(mcpRefusal(cmd, access, true, true)?.status).toBe(403)
  })
  it('off refuses every command and names the setting', () => {
    const r = mcpRefusal('jobs-list', 'off', false, false)
    expect(r?.status).toBe(403)
    expect(r?.body.error).toMatch(/MCP access/)
  })
  it('read admits the reads and refuses the mutations', () => {
    for (const cmd of MCP_READ_COMMANDS) expect(mcpRefusal(cmd, 'read', false, false)).toBeNull()
    for (const cmd of MCP_CONTROL_COMMANDS) expect(mcpRefusal(cmd, 'read', false, false)?.status).toBe(403)
  })
  it('control admits both lists', () => {
    for (const cmd of [...MCP_READ_COMMANDS, ...MCP_CONTROL_COMMANDS]) expect(mcpRefusal(cmd, 'control', false, false)).toBeNull()
  })
  it('runs-resume is a control command: stop_run has its way back', () => {
    expect(mcpRefusal('runs-resume', 'control', false, false)).toBeNull()
    expect(mcpRefusal('runs-resume', 'read', false, false)?.status).toBe(403)
  })
  it('tasks-add is a control command and run-configs-list a read: create_task and list_run_configs', () => {
    expect(mcpRefusal('tasks-add', 'control', false, false)).toBeNull()
    expect(mcpRefusal('tasks-add', 'read', false, false)?.status).toBe(403)
    expect(mcpRefusal('run-configs-list', 'read', false, false)).toBeNull()
  })
  it('tasks-check-output and tasks-output are reads: get_check_output and get_task_output', () => {
    for (const cmd of ['tasks-check-output', 'tasks-output']) expect(mcpRefusal(cmd, 'read', false, false)).toBeNull()
  })
  it('understanding-list and understanding-get are reads, with no second setting: list_work_records and get_work_record', () => {
    for (const cmd of ['understanding-list', 'understanding-get']) {
      expect(MCP_READ_COMMANDS).toContain(cmd)
      for (const access of ['read', 'control'] as const) expect(mcpRefusal(cmd, access, false, false)).toBeNull()
      expect(mcpRefusal(cmd, 'off', true, true)?.status).toBe(403)
    }
  })
  it('understanding-regenerate is a control command, with no second setting: regenerate_work_record', () => {
    expect(MCP_CONTROL_COMMANDS).toContain('understanding-regenerate')
    expect(mcpRefusal('understanding-regenerate', 'control', false, false)).toBeNull()
    const r = mcpRefusal('understanding-regenerate', 'read', true, true)
    expect(r?.status).toBe(403)
    expect(r?.body.error).toMatch(/Read and control/)
    expect(mcpRefusal('understanding-regenerate', 'off', true, true)?.status).toBe(403)
  })
  it('understanding-unit is the app’s alone: never open to MCP', () => {
    for (const access of ['read', 'control'] as const) expect(mcpRefusal('understanding-unit', access, true, true)?.status).toBe(403)
  })
  it('runs-follow is a read, with no second setting: wait_for_run', () => {
    expect(MCP_READ_COMMANDS).toContain('runs-follow')
    for (const access of ['read', 'control'] as const) expect(mcpRefusal('runs-follow', access, false, false)).toBeNull()
    expect(mcpRefusal('runs-follow', 'off', true, true)?.status).toBe(403)
  })
  it('refuses everything else whatever the setting', () => {
    for (const sessions of [false, true])
      for (const cmd of ['worker-start', 'chats-answer', 'state-put', 'run-delete', 'task-create', 'run-configs', 'run-resume'])
        expect(mcpRefusal(cmd, 'control', sessions, false)?.status).toBe(403)
  })

  describe('session commands', () => {
    it('the lists are the four session commands', () => {
      expect([...MCP_SESSION_READ_COMMANDS]).toEqual(['sessions-list', 'sessions-read'])
      expect([...MCP_SESSION_WRITE_COMMANDS]).toEqual(['sessions-send', 'sessions-create'])
    })
    it('access off refuses every session command whatever mcpSessions says', () => {
      for (const sessions of [false, true])
        for (const cmd of ['sessions-list', 'sessions-read', 'sessions-send', 'sessions-create'])
          expect(mcpRefusal(cmd, 'off', sessions, false)?.body.error).toMatch(/MCP access is off/)
    })
    it('mcpSessions off refuses all four and names the setting', () => {
      for (const access of ['read', 'control'] as const)
        for (const cmd of ['sessions-list', 'sessions-read', 'sessions-send', 'sessions-create']) {
          const r = mcpRefusal(cmd, access, false, false)
          expect(r?.status).toBe(403)
          expect(r?.body.error).toMatch(/Let MCP clients see and use sessions/)
          expect(r?.body.error).toMatch(/CLI tab/)
        }
    })
    it('mcpSessions on + read admits the session reads and refuses the writes', () => {
      expect(mcpRefusal('sessions-list', 'read', true, false)).toBeNull()
      expect(mcpRefusal('sessions-read', 'read', true, false)).toBeNull()
      for (const cmd of ['sessions-send', 'sessions-create']) {
        const r = mcpRefusal(cmd, 'read', true, false)
        expect(r?.status).toBe(403)
        expect(r?.body.error).toMatch(/Read and control/)
      }
    })
    it('mcpSessions on + control admits all four', () => {
      for (const cmd of ['sessions-list', 'sessions-read', 'sessions-send', 'sessions-create'])
        expect(mcpRefusal(cmd, 'control', true, false)).toBeNull()
    })
    it('mcpSessions on does not open the other commands', () => {
      for (const cmd of ['worker-start', 'jobs-list-x', 'sessions-delete'])
        expect(mcpRefusal(cmd, 'control', true, false)?.status).toBe(403)
      expect(mcpRefusal('jobs-list', 'read', false, false)).toBeNull()
    })
  })

  // Plugin Phase 4 J11: the job sources' reads are reads; a Job made from one is control, and from GitHub a GitHub write
  describe('job-source commands', () => {
    it('admits the three reads at read and control', () => {
      for (const access of ['read', 'control'] as const)
        for (const cmd of ['sources-list', 'sources-items', 'sources-show']) expect(mcpRefusal(cmd, access, false, false), cmd).toBeNull()
    })
    it('admits a Job from a plugin’s source at control only', () => {
      const args = { source: 'astera-linear-source', item: 'ENG-1', project: 'p' }
      expect(mcpRefusal('jobs-create-from-source', 'control', false, false, args)).toBeNull()
      expect(mcpRefusal('jobs-create-from-source', 'read', false, false, args)?.status).toBe(403)
    })
    it('needs the GitHub-write setting too for a Job from the GitHub source', () => {
      const args = { source: 'github', item: '12', project: 'p' }
      expect(mcpRefusal('jobs-create-from-source', 'control', false, false, args)?.body.error).toMatch(/Let MCP clients act on GitHub/)
      expect(mcpRefusal('jobs-create-from-source', 'control', false, true, args)).toBeNull()
      expect(mcpRefusal('jobs-create-from-source', 'read', false, true, args)?.status).toBe(403)
    })
  })

  describe('GitHub commands', () => {
    const OFF_MSG = /Let MCP clients act on GitHub/
    it('the write list is the four GitHub writes; the three reads are plain reads', () => {
      expect([...MCP_GITHUB_WRITE_COMMANDS]).toEqual(['github-pr-create', 'github-ci-rerun', 'jobs-create-from-issue', 'runs-reconverge'])
      for (const cmd of ['github-pr', 'github-ci', 'github-issue']) expect(MCP_READ_COMMANDS).toContain(cmd)
    })
    it('access off refuses everything whatever mcpGithubWrite says', () => {
      for (const gh of [false, true])
        for (const cmd of ['github-issue', 'github-pr-create', 'jobs-create'])
          expect(mcpRefusal(cmd, 'off', false, gh)?.body.error).toMatch(/MCP access is off/)
    })
    it('a Job made with the GitHub lifecycle is a GitHub write (design §7.1)', () => {
      for (const cmd of ['jobs-create', 'jobs-create-from-source', 'jobs-create-from-issue']) {
        expect(mcpRefusal(cmd, 'control', false, false, { githubLifecycle: true })?.status).toBe(403)
        expect(mcpRefusal(cmd, 'control', false, true, { githubLifecycle: true })).toBeNull()
      }
      expect(mcpRefusal('jobs-create', 'control', false, false, {})).toBeNull()
    })
    it('a GitHub read is admitted at read and control, with the setting either way', () => {
      for (const access of ['read', 'control'] as const)
        for (const gh of [false, true]) expect(mcpRefusal('github-issue', access, false, gh)).toBeNull()
    })
    it('a GitHub write with the setting off is refused at every access and names the setting', () => {
      for (const access of ['read', 'control'] as const)
        for (const cmd of MCP_GITHUB_WRITE_COMMANDS) {
          const r = mcpRefusal(cmd, access, true, false)
          expect(r?.status).toBe(403)
          expect(r?.body.error).toMatch(OFF_MSG)
          expect(r?.body.error).toMatch(/Settings \(CLI tab\)/)
        }
    })
    it('the setting on + read refuses with the Read and control message', () => {
      for (const cmd of MCP_GITHUB_WRITE_COMMANDS) {
        const r = mcpRefusal(cmd, 'read', false, true)
        expect(r?.status).toBe(403)
        expect(r?.body.error).toMatch(/"Read and control"/)
        expect(r?.body.error).not.toMatch(OFF_MSG)
      }
    })
    it('the setting on + control admits the writes', () => {
      for (const cmd of MCP_GITHUB_WRITE_COMMANDS) expect(mcpRefusal(cmd, 'control', false, true)).toBeNull()
    })
    it('the setting does not open other control commands', () => {
      expect(mcpRefusal('jobs-create', 'read', false, true)?.status).toBe(403)
      expect(mcpRefusal('jobs-create', 'control', false, false)).toBeNull()
    })
  })
})
