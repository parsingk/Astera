// What a `gh` call Astera runs is, for its credential-use record (credentials design §6): the action and the repository it
// names. The recorder fills the repository from the folder's origin when the call names none.
import { describe, it, expect } from 'vitest'
import { classifyGh, repoOfOrigin } from './githubUse'

describe('classifyGh', () => {
  it('classifies pr create, run rerun and reads', () => {
    expect(classifyGh(['pr', 'create', '--draft', '--title', 't'])).toEqual({ action: 'github.pr.create' })
    expect(classifyGh(['run', 'rerun', '123', '--failed'])).toEqual({ action: 'github.ci.rerun', number: '123' })
    expect(classifyGh(['pr', 'view', '45', '--json', 'state'])).toEqual({ action: 'github.read', number: '#45' })
    expect(classifyGh(['pr', 'checks', '7'])).toEqual({ action: 'github.read', number: '#7' })
    expect(classifyGh(['run', 'view', '99', '--log-failed'])).toEqual({ action: 'github.read', number: '99' })
    expect(classifyGh(['api', 'repos/{owner}/{repo}/issues'])).toEqual({ action: 'github.read' })
    expect(classifyGh(['repo', 'view', 'o/r', '--json', 'nameWithOwner'])).toEqual({ action: 'github.read', repoArg: 'o/r' })
  })

  it('takes the repository a -R or --repo names', () => {
    expect(classifyGh(['pr', 'create', '-R', 'other/x'])).toEqual({ action: 'github.pr.create', repoArg: 'other/x' })
    expect(classifyGh(['pr', 'list', '--repo', 'github.com/o/r'])).toEqual({ action: 'github.read', repoArg: 'o/r' })
    expect(classifyGh(['pr', 'list', '--repo=o/r'])).toEqual({ action: 'github.read', repoArg: 'o/r' })
  })

  it('reads an api call that writes as a write, and anything else as a read it names', () => {
    expect(classifyGh(['api', '-X', 'POST', 'repos/o/r/issues'])).toEqual({ action: 'github.write', other: 'gh api' })
    expect(classifyGh(['auth', 'status'])).toEqual({ action: 'github.read', other: 'gh auth status' })
  })

  // Final review I1: fields sent with -f are a query's as much as a write's; the audit resolver's rules decide
  it('reads a GraphQL query and a GET search sent with fields as reads, and a mutation as a write', () => {
    const query = ['api', 'graphql', '-f', 'owner=o', '-f', 'name=r', '-F', 'number=3', '-f', 'query=query($owner:String!){ repository(owner:$owner){ id } }']
    expect(classifyGh(query).action).toBe('github.read')
    expect(classifyGh(['api', '--hostname', 'ghe.example.com', ...query.slice(1)]).action).toBe('github.read')
    expect(classifyGh(['api', '-X', 'GET', 'search/issues', '-f', 'q=repo:o/r is:issue', '-f', 'per_page=50']).action).toBe('github.read')
    expect(classifyGh(['api', 'graphql', '-f', 'query=mutation { addComment(input:{}) { clientMutationId } }']).action).toBe('github.write')
    expect(classifyGh(['api', 'repos/o/r/issues', '-f', 'title=x']).action).toBe('github.write')
  })

  it('reads the gh verbs that change something as writes', () => {
    for (const args of [['pr', 'merge', '3'], ['pr', 'edit', '3', '--title', 'x'], ['issue', 'create', '--title', 'x'], ['issue', 'comment', '4'], ['run', 'cancel', '9'], ['release', 'create', 'v1']])
      expect(classifyGh(args), args.join(' ')).toEqual({ action: 'github.write', other: `gh ${args[0]} ${args[1]}` })
    expect(classifyGh(['issue', 'view', '4']).action).toBe('github.read')
  })
})

describe('repoOfOrigin', () => {
  it('reads owner/name from the usual origin URLs and nothing from others', () => {
    expect(repoOfOrigin('https://github.com/parsingk/Astera.git')).toBe('parsingk/Astera')
    expect(repoOfOrigin('git@github.com:parsingk/Astera.git')).toBe('parsingk/Astera')
    expect(repoOfOrigin('https://user:secret@github.com/o/r')).toBe('o/r')
    expect(repoOfOrigin('https://gitlab.example.com/o/r.git')).toBeNull()
    expect(repoOfOrigin(null)).toBeNull()
  })
})
