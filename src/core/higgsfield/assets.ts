// Ids that cross accounts (higgsfield accounts design §4). The CLI takes a local path wherever it takes
// an upload or job id, and uploads it itself, so an id from another account is swapped for the file it
// stands for. Only ids this proxy saw created are known; anything else passes through.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { renameRetrying } from '../renameRetry'
import { hfRoot } from './accounts'
import { subIndex } from './credits'

export interface HfAssetLedger {
  uploads: Record<string, { account: string; path: string }>
  jobs: Record<string, { account: string; file?: string }>
}
export const MEDIA_FLAGS = ['--image', '--video', '--audio', '--start-image', '--end-image',
  '--image-references', '--video-references', '--audio-references', '--sketch']
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const fileOf = (profileDir: string) => path.join(hfRoot(profileDir), 'assets.json')

export async function readLedger(profileDir: string): Promise<HfAssetLedger> {
  try {
    const raw = JSON.parse(await fs.readFile(fileOf(profileDir), 'utf8'))
    return { uploads: raw?.uploads ?? {}, jobs: raw?.jobs ?? {} }
  } catch {
    return { uploads: {}, jobs: {} }
  }
}

export async function writeLedger(profileDir: string, l: HfAssetLedger): Promise<void> {
  const file = fileOf(profileDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(tmp, JSON.stringify(l, null, 2), 'utf8'); await renameRetrying(tmp, file) }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}) }
}

export async function recordAfter(profileDir: string, account: string, args: string[], stdout: string): Promise<void> {
  const ids = [...new Set(stdout.match(UUID) ?? [])].map((s) => s.toLowerCase())
  if (!ids.length) return
  const i = subIndex(args)
  const l = await readLedger(profileDir)
  if (args[i] === 'upload' && args[i + 1] === 'create' && args[i + 2]) {
    for (const id of ids) l.uploads[id] = { account, path: path.resolve(args[i + 2]) }
  } else if (args[i] === 'generate' && (args[i + 1] === 'create' || args[i + 1] === 'workflow')) {
    for (const id of ids) l.jobs[id] ??= { account }
  } else return
  await writeLedger(profileDir, l)
}

export function foreignIds(args: string[], l: HfAssetLedger, account: string): { index: number; id: string; prefix: string }[] {
  const out: { index: number; id: string; prefix: string }[] = []
  const owner = (id: string) => l.uploads[id]?.account ?? l.jobs[id]?.account
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    const eq = t.indexOf('=')
    const flag = eq > 0 ? t.slice(0, eq) : t
    if (!MEDIA_FLAGS.includes(flag)) continue
    const index = eq > 0 ? i : i + 1
    const value = (eq > 0 ? t.slice(eq + 1) : args[i + 1] ?? '').toLowerCase()
    const who = owner(value)
    if (who !== undefined && who !== account) out.push({ index, id: value, prefix: eq > 0 ? `${flag}=` : '' })
    if (eq <= 0) i++
  }
  return out
}

export function firstMediaUrl(json: string): string | null {
  const plain = json.split('\\/').join('/')   // tolerate an encoder that escapes slashes
  const m = plain.match(/https?:\/\/[^"\s]+?\.(mp4|mov|webm|png|jpe?g|webp|gif|mp3|wav|m4a|glb)(\?[^"\s]*)?(?=")/i)
  return m ? m[0] : null
}

/** Download `url` to `<profile>/higgsfield/assets/<id><ext>` (tmp file, then rename). Throws on failure,
 *  after removing the tmp file. */
export async function downloadAsset(profileDir: string, id: string, url: string, doFetch: typeof fetch): Promise<string> {
  const dir = path.join(hfRoot(profileDir), 'assets')
  let ext = '.bin'
  try { ext = path.extname(new URL(url).pathname) || '.bin' } catch { /* keep .bin */ }
  const dest = path.join(dir, `${id}${ext}`)
  const tmp = `${dest}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(dir, { recursive: true })
    const res = await doFetch(url)
    if (!res.ok) throw new Error(`download answered ${res.status}`)
    await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()))
    await renameRetrying(tmp, dest)
    return dest
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

/** Record where a job's media was saved. */
export async function recordJobFile(profileDir: string, id: string, file: string): Promise<void> {
  const l = await readLedger(profileDir)
  if (!l.jobs[id]) return
  l.jobs[id].file = file
  await writeLedger(profileDir, l)
}
