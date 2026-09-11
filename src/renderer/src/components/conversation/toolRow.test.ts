import { describe, it, expect } from 'vitest'
import { verbKeyOf, summarize, shortenTarget } from './ToolRow'

describe('verbKeyOf', () => {
  it('maps each of the six tool names to its verb key', () => {
    expect(verbKeyOf('Read')).toBe('conversation.verb.read')
    expect(verbKeyOf('Grep')).toBe('conversation.verb.find')
    expect(verbKeyOf('Glob')).toBe('conversation.verb.find')
    expect(verbKeyOf('Edit')).toBe('conversation.verb.edit')
    expect(verbKeyOf('Write')).toBe('conversation.verb.create')
    expect(verbKeyOf('Bash')).toBe('conversation.verb.run')
  })

  it('passes an unknown tool name through unchanged', () => {
    expect(verbKeyOf('WebFetch')).toBe('WebFetch')
  })
})

describe('summarize', () => {
  it('counts a run by kind, in the order each kind first appeared', () => {
    expect(summarize(['Read', 'Grep', 'Edit', 'Edit', 'Bash'])).toEqual([
      { kind: 'read', count: 1 },
      { kind: 'find', count: 1 },
      { kind: 'edit', count: 2 },
      { kind: 'run', count: 1 }
    ])
  })

  it('is not alphabetical — a later-first-appearing kind still sorts after an earlier one', () => {
    // 'find' (Grep) appears before 'edit' (Write) here, so it must lead — alphabetically 'edit'
    // would come first.
    expect(summarize(['Grep', 'Write'])).toEqual([
      { kind: 'find', count: 1 },
      { kind: 'create', count: 1 }
    ])
  })

  it('is empty for an empty run', () => {
    expect(summarize([])).toEqual([])
  })

  it('keeps an unrecognized tool as its own kind, unmerged with any other unrecognized tool', () => {
    expect(summarize(['WebFetch', 'Task', 'WebFetch'])).toEqual([
      { kind: 'WebFetch', count: 2 },
      { kind: 'Task', count: 1 }
    ])
  })
})

describe('shortenTarget', () => {
  it('keeps the full path for Read', () => {
    expect(shortenTarget('Read', 'src/main/orchestration/store.ts')).toBe(
      'src/main/orchestration/store.ts'
    )
  })

  it('keeps only the basename for Edit and Write', () => {
    expect(shortenTarget('Edit', 'src/main/orchestration/store.ts')).toBe('store.ts')
    expect(shortenTarget('Write', 'src/main/orchestration/store.ts')).toBe('store.ts')
  })

  it('passes Bash and Grep through untouched', () => {
    expect(shortenTarget('Bash', 'vitest run store.test.ts')).toBe('vitest run store.test.ts')
    expect(shortenTarget('Grep', 'TODO.*urgent')).toBe('TODO.*urgent')
  })
})
