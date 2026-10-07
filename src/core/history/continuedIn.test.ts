import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { followContinuedIn } from './continuedIn'

let root: string
let slug: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'continued-in-'))
  slug = path.join(root, 'D--work-astera')
  await mkdir(slug)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const line = (o: Record<string, unknown>): string => JSON.stringify(o)
const userPrompt = (text: string): string => line({ type: 'user', message: { role: 'user', content: text } })
const toolResult = (): string =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })
const assistant = (text: string): string =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const backgrounding = (): string =>
  line({ type: 'system', subtype: 'informational', content: 'Backgrounding after the current tool finishes…' })
const continuedIn = (from: string, to: string): string =>
  line({ type: 'continued-in', sessionId: from, continuedInSessionId: to })

async function transcript(dir: string, id: string, lines: string[]): Promise<string> {
  const file = path.join(dir, `${id}.jsonl`)
  await writeFile(file, lines.join('\n') + '\n')
  return file
}

describe('followContinuedIn', () => {
  it('leaves a conversation that never moved where it is', async () => {
    const file = await transcript(slug, 'aaa', [userPrompt('hi'), assistant('hello')])
    expect(await followContinuedIn({ sessionId: 'aaa', transcriptPath: file })).toEqual({
      sessionId: 'aaa',
      transcriptPath: file
    })
  })

  it('follows a conversation sent to the background to the copy it continued in', async () => {
    const file = await transcript(slug, 'aaa', [userPrompt('hi'), toolResult(), backgrounding(), toolResult(), continuedIn('aaa', 'bbb')])
    const fork = await transcript(slug, 'bbb', [userPrompt('hi'), assistant('still going')])
    expect(await followContinuedIn({ sessionId: 'aaa', transcriptPath: file })).toEqual({
      sessionId: 'bbb',
      transcriptPath: fork
    })
  })

  // What happened on 2026-10-07: the old id was resumed (twice) after the move, and each resume
  // appended a synthetic answer and system lines behind the record. Nobody spoke in the old copy.
  it('still follows once a resume of the old id has written lines behind the record', async () => {
    const file = await transcript(slug, 'aaa', [
      userPrompt('hi'),
      continuedIn('aaa', 'bbb'),
      assistant('No response requested.'),
      line({ type: 'system', subtype: 'informational', content: 'Remote Control not started here' }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/exit</command-name>' } })
    ])
    const fork = await transcript(slug, 'bbb', [userPrompt('hi')])
    expect(await followContinuedIn({ sessionId: 'aaa', transcriptPath: file })).toEqual({
      sessionId: 'bbb',
      transcriptPath: fork
    })
  })

  it('stays when the person kept talking in the old copy after the move', async () => {
    const file = await transcript(slug, 'aaa', [userPrompt('hi'), continuedIn('aaa', 'bbb'), userPrompt('carry on here')])
    await transcript(slug, 'bbb', [userPrompt('hi')])
    expect(await followContinuedIn({ sessionId: 'aaa', transcriptPath: file })).toEqual({
      sessionId: 'aaa',
      transcriptPath: file
    })
  })

  // Claude writes the copy's transcript only once something is said in it: `/background` on an idle
  // conversation leaves the record and no file (measured 2026-10-07). The id is still handed back, so
  // the caller can ask whether a background session holds it.
  it('stays when the copy it names has no transcript yet, and names that copy', async () => {
    const file = await transcript(slug, 'aaa', [userPrompt('hi'), continuedIn('aaa', 'bbb')])
    expect(await followContinuedIn({ sessionId: 'aaa', transcriptPath: file })).toEqual({
      sessionId: 'aaa',
      transcriptPath: file,
      unfiled: 'bbb'
    })
  })

  // The background copy is filed under the folder it runs in, which need not be the one the original
  // was started in (the original moved from a subfolder of the project on 2026-10-07).
  it('finds the copy in another project folder of the same account', async () => {
    const file = await transcript(slug, 'aaa', [userPrompt('hi'), continuedIn('aaa', 'bbb')])
    const other = path.join(root, 'D--work-astera-docs')
    await mkdir(other)
    const fork = await transcript(other, 'bbb', [userPrompt('hi')])
    expect(await followContinuedIn({ sessionId: 'aaa', transcriptPath: file })).toEqual({
      sessionId: 'bbb',
      transcriptPath: fork
    })
  })

  it('follows a copy that itself moved again', async () => {
    const file = await transcript(slug, 'aaa', [userPrompt('hi'), continuedIn('aaa', 'bbb')])
    await transcript(slug, 'bbb', [userPrompt('hi'), continuedIn('bbb', 'ccc')])
    const last = await transcript(slug, 'ccc', [userPrompt('hi')])
    expect(await followContinuedIn({ sessionId: 'aaa', transcriptPath: file })).toEqual({
      sessionId: 'ccc',
      transcriptPath: last
    })
  })

  it('stops on a loop instead of going round it', async () => {
    const file = await transcript(slug, 'aaa', [userPrompt('hi'), continuedIn('aaa', 'bbb')])
    const fork = await transcript(slug, 'bbb', [userPrompt('hi'), continuedIn('bbb', 'aaa')])
    const r = await followContinuedIn({ sessionId: 'aaa', transcriptPath: file })
    expect([r.sessionId, r.transcriptPath]).toEqual(['bbb', fork])
  })

  it('ignores a record that names some other conversation', async () => {
    const file = await transcript(slug, 'aaa', [userPrompt('hi'), continuedIn('zzz', 'bbb')])
    await transcript(slug, 'bbb', [userPrompt('hi')])
    expect((await followContinuedIn({ sessionId: 'aaa', transcriptPath: file })).sessionId).toBe('aaa')
  })

  it('leaves the resume alone when the transcript cannot be read', async () => {
    const missing = path.join(slug, 'gone.jsonl')
    expect(await followContinuedIn({ sessionId: 'gone', transcriptPath: missing })).toEqual({
      sessionId: 'gone',
      transcriptPath: missing
    })
  })
})
