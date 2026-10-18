// Which GitHub repository a folder's origin names (GitHub lifecycle L24: origin only).
import { describe, it, expect } from 'vitest'
import { ghRepoArg, hostnameArgs, parseGitHubRemote, repoOfBinding, repoSlug } from './remote'

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/parsingk/Astera.git', { host: 'github.com', owner: 'parsingk', name: 'Astera' }],
    ['https://github.com/parsingk/Astera', { host: 'github.com', owner: 'parsingk', name: 'Astera' }],
    ['git@github.com:parsingk/Astera.git', { host: 'github.com', owner: 'parsingk', name: 'Astera' }],
    ['ssh://git@github.com/parsingk/Astera.git', { host: 'github.com', owner: 'parsingk', name: 'Astera' }],
    ['https://user:ghp_secret@github.com/parsingk/Astera.git', { host: 'github.com', owner: 'parsingk', name: 'Astera' }],
    ['https://GHE.Example.com/team/app.git', { host: 'ghe.example.com', owner: 'team', name: 'app' }]
  ])('reads %s', (url, repo) => expect(parseGitHubRemote(url)).toEqual(repo))

  it.each(['D:/repos/app', '/srv/git/app.git', 'https://github.com/only-owner', 'https://github.com/a/b/c', ''])(
    'refuses %s',
    (url) => expect(parseGitHubRemote(url)).toBeNull()
  )
})

describe('gh arguments', () => {
  it('names a github.com repository without a host and any other with one', () => {
    const dotcom = { host: 'github.com', owner: 'o', name: 'r' }
    const ghe = { host: 'ghe.example.com', owner: 'o', name: 'r' }
    expect(repoSlug(ghe)).toBe('o/r')
    expect(ghRepoArg(dotcom)).toBe('o/r')
    expect(ghRepoArg(ghe)).toBe('ghe.example.com/o/r')
    expect(hostnameArgs(dotcom)).toEqual([])
    expect(hostnameArgs(ghe)).toEqual(['--hostname', 'ghe.example.com'])
  })
})

describe('repoOfBinding', () => {
  it('reads owner/name and the host a binding names, github.com when it names none', () => {
    expect(repoOfBinding({ repository: 'o/r' })).toEqual({ host: 'github.com', owner: 'o', name: 'r' })
    expect(repoOfBinding({ repository: 'o/r', host: 'ghe.example' })).toEqual({ host: 'ghe.example', owner: 'o', name: 'r' })
  })
  it('is null for a repository that is not owner/name', () => {
    for (const repository of ['o', 'o/r/x', '/r', 'o/', '']) expect(repoOfBinding({ repository })).toBeNull()
  })
})
