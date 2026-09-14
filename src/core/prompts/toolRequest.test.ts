import { describe, it, expect } from 'vitest'
import { describeToolRequest } from './toolRequest'

describe('describeToolRequest', () => {
  it('a shell tool: the command, then its description when there is one', () => {
    expect(describeToolRequest('Bash', { command: 'npm test', description: 'Run the suite' })).toEqual({
      tool: 'Bash',
      lines: ['npm test', 'Run the suite']
    })
    expect(describeToolRequest('PowerShell', { command: 'Get-ChildItem' })).toEqual({ tool: 'PowerShell', lines: ['Get-ChildItem'] })
  })
  it('a file tool: the path', () => {
    expect(describeToolRequest('Write', { file_path: 'src/a.ts', content: 'x' })).toEqual({ tool: 'Write', lines: ['src/a.ts'] })
    expect(describeToolRequest('NotebookEdit', { notebook_path: 'nb.ipynb' })).toEqual({ tool: 'NotebookEdit', lines: ['nb.ipynb'] })
  })
  it('Edit: the path, then the first three lines of old and new text, marked', () => {
    expect(
      describeToolRequest('Edit', { file_path: 'src/a.ts', old_string: 'a\nb\nc\nd', new_string: 'x' })
    ).toEqual({ tool: 'Edit', lines: ['src/a.ts', '- a\n  b\n  c\n  …', '+ x'] })
  })
  it('null for an unknown tool, or a known tool with nothing to show', () => {
    expect(describeToolRequest('Read', { file_path: 'x' })).toBeNull()
    expect(describeToolRequest('Bash', {})).toBeNull()
    expect(describeToolRequest('Bash', null)).toBeNull()
    expect(describeToolRequest('AskUserQuestion', { questions: [] })).toBeNull()
  })
})
