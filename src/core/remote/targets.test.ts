import { describe, it, expect } from 'vitest'
import { remoteTarget } from './targets'

describe('remoteTarget (remote runtime design §3.4, X1-14)', () => {
  it('is yes exactly for what the controller gate lets through', () => {
    for (const cmd of ['projects-list', 'accounts-list', 'jobs-list', 'jobs-create', 'jobs-run', 'runs-stop', 'runs-wait', 'jobs-wait', 'runs-follow', 'sessions-create', 'questions-answer'])
      expect(remoteTarget(cmd), cmd).toBe('yes')
  })
  it('is no for what runs on this machine only, and for what a controller never reaches', () => {
    for (const cmd of ['host-start', 'host-status', 'skills-list', 'higgsfield-use', 'mcp-serve', 'mcp-status', 'runtime-pair', 'runtime-start', 'runtimes-add', 'projects-add', 'browser-js', 'app-js', 'state-put', 'github-pr-create', 'help', 'version'])
      expect(remoteTarget(cmd), cmd).toBe('no')
  })
})
