import { describe, it, expect } from 'vitest'
import { frontmatterDescription, filterSlashCommands, type SlashCommand } from './slashCommands'

describe('frontmatterDescription', () => {
  it('reads the description out of a frontmatter block', () => {
    expect(frontmatterDescription('---\nname: report\ndescription: 활동을 보고서로\n---\n\n# body')).toBe(
      '활동을 보고서로'
    )
  })

  it('drops the quotes a description may be written with', () => {
    expect(frontmatterDescription('---\ndescription: "[기간] 단위"\n---\n')).toBe('[기간] 단위')
  })

  // The body is the long part of a skill file and it is full of prose that could match anything.
  it('never reads past the block, or out of a file that has no block', () => {
    expect(frontmatterDescription('---\nname: a\n---\ndescription: not this one\n')).toBe('')
    expect(frontmatterDescription('# just a document\ndescription: nor this\n')).toBe('')
  })
})

describe('filterSlashCommands', () => {
  const commands: SlashCommand[] = [
    { name: 'report', description: '', source: 'plugin' },
    { name: 'brainstorming', description: '', source: 'plugin' },
    { name: 'astera-task', description: '', source: 'user' }
  ]

  it('offers everything on a bare slash', () => {
    expect(filterSlashCommands(commands, '/')?.map((c) => c.name)).toEqual([
      'report',
      'brainstorming',
      'astera-task'
    ])
  })

  it('narrows on what has been typed, anywhere in the name', () => {
    expect(filterSlashCommands(commands, '/task')?.map((c) => c.name)).toEqual(['astera-task'])
    expect(filterSlashCommands(commands, '/BRAIN')?.map((c) => c.name)).toEqual(['brainstorming'])
  })

  // Enter takes the first row, so this is not about tidiness: typing `r` has to offer `report`
  // before something with an r buried in the middle of it.
  it('puts what starts with the typed letters ahead of what merely contains them', () => {
    const found = filterSlashCommands(
      [
        { name: 'astera-report', description: '', source: 'user' },
        { name: 'report', description: '', source: 'plugin' }
      ],
      '/rep'
    )
    expect(found?.map((c) => c.name)).toEqual(['report', 'astera-report'])
  })

  // The two cases that decide whether the menu is help or a nuisance.
  it('stays away from a message that merely contains a slash, and from arguments', () => {
    expect(filterSlashCommands(commands, 'src/main 을 봐줘')).toBeNull()
    expect(filterSlashCommands(commands, '/report 7d')).toBeNull()
  })
})
