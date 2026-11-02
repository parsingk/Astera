// What a shared skill or agent's canonical copy says of itself (lifecycle design §4.12): the frontmatter `name` Claude Code
// also knows it by, the skills an agent's `skills:` preloads, and the agent a skill's `agent:` runs in. A use is matched by
// these; a copy that cannot be read is left out, so its item is not judged.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { extensionPaths } from '../profile/paths'
import { copyFrontmatter, readExtensionCopies } from './copies'
import type { FileExtension } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-copies-'))
  dirs.push(d)
  return d
}

describe('what a canonical copy says it is called', () => {
  it('reads a frontmatter name and a skills list, inline, comma separated or as a block', () => {
    expect(copyFrontmatter('---\nname: Code Reviewer\ndescription: x\n---\nbody')).toEqual({ name: 'Code Reviewer' })
    expect(copyFrontmatter('---\r\nname: "quoted name"\r\nskills: [a, "b"]\r\n---\r\n')).toEqual({ name: 'quoted name', skills: ['a', 'b'] })
    expect(copyFrontmatter("---\nname: 'single' # a comment\nskills: a, b\n---\n")).toEqual({ name: 'single', skills: ['a', 'b'] })
    expect(copyFrontmatter('---\nname: api-developer\nskills:\n  - api-conventions\n  - error-handling-patterns\ntools: Read\n---\nskills: not-this')).toEqual({
      name: 'api-developer',
      skills: ['api-conventions', 'error-handling-patterns']
    })
    // A byte order mark, no frontmatter, a name only in the body
    expect(copyFrontmatter(String.fromCharCode(0xfeff) + '---\nname: bom\n---\n')).toEqual({ name: 'bom' })
    expect(copyFrontmatter('# title\nname: body\n')).toEqual({})
    expect(copyFrontmatter('---\ndescription: none\n---\nname: body')).toEqual({})
  })

  // Ruling R6-5: a `context: fork` skill runs in the agent its `agent:` names, which may start with no SubagentStart
  it('reads the agent a skill runs in', () => {
    expect(copyFrontmatter('---\nname: deep-research\ncontext: fork\nagent: Explore\n---\n')).toEqual({ name: 'deep-research', agent: 'Explore' })
    expect(copyFrontmatter('---\nagent: "Code Reviewer"\n---\n')).toEqual({ agent: 'Code Reviewer' })
  })

  it('reads each shared skill and agent copy, and leaves out one that cannot be read', async () => {
    const p = await profile()
    const paths = extensionPaths(p)
    const entry = (kind: FileExtension['kind'], name: string): FileExtension => ({ id: `${kind}-${name}`, kind, name, hash: 'h', providers: ['claude'], importedFrom: 'acc1', enabled: true })
    await fs.mkdir(path.join(paths.skills, 'review'), { recursive: true })
    await fs.writeFile(path.join(paths.skills, 'review', 'SKILL.md'), '---\nname: reviewing\ndescription: d\ncontext: fork\nagent: reviewer\n---\n')
    await fs.mkdir(path.join(paths.skills, 'plain'), { recursive: true })
    await fs.writeFile(path.join(paths.skills, 'plain', 'SKILL.md'), '# no frontmatter\n')
    await fs.mkdir(paths.agents, { recursive: true })
    await fs.writeFile(path.join(paths.agents, 'reviewer.md'), '---\nname: Code Reviewer\nskills:\n  - review\n---\n')
    const copies = await readExtensionCopies(p, [
      entry('skill', 'review'),
      entry('skill', 'plain'),
      entry('skill', 'gone'),
      entry('agent', 'reviewer'),
      entry('agent', 'missing'),
      entry('command', 'ship'),
      { id: 'mcp-x', kind: 'mcp', name: 'x', transport: 'stdio', env: {}, providers: ['claude'], importedFrom: 'acc1', enabled: true }
    ])
    expect(Object.fromEntries(copies)).toEqual({
      'skill-review': { name: 'reviewing', agent: 'reviewer' },
      'skill-plain': {},
      'agent-reviewer': { name: 'Code Reviewer', skills: ['review'] }
    })
  })
})
