import { describe, it, expect } from 'vitest'
import { remoteTarget } from './targets'

describe('remoteTarget (remote runtime design §3.4, X1-14)', () => {
  it('is yes exactly for what the controller gate lets through', () => {
    for (const cmd of ['projects-list', 'accounts-list', 'jobs-list', 'jobs-create', 'jobs-run', 'runs-stop', 'runs-wait', 'jobs-wait', 'runs-follow', 'sessions-create', 'questions-answer', 'runs-reconverge'])
      expect(remoteTarget(cmd), cmd).toBe('yes')
  })
  it('is no for what runs on this machine only, and for what a controller never reaches', () => {
    for (const cmd of ['host-start', 'host-status', 'skills-list', 'higgsfield-use', 'mcp-serve', 'mcp-status', 'runtime-pair', 'runtime-start', 'runtimes-add', 'projects-add', 'browser-js', 'app-js', 'state-put', 'github-pr-create', 'help', 'version'])
      expect(remoteTarget(cmd), cmd).toBe('no')
  })
  // Observe mode design §3, §12: `--runtime` never reads another machine's audit log or changes its rules
  it('is no for every audit and policies command', () => {
    for (const cmd of ['audit-list', 'audit-summary', 'policies-show', 'policies-set-mode', 'policies-set-otherwise', 'policies-rules-add', 'policies-rules-edit', 'policies-rules-remove', 'policies-rules-move', 'policies-rules-reset'])
      expect(remoteTarget(cmd), cmd).toBe('no')
  })
})
