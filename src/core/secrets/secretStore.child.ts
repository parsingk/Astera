// Run by secretStore.test.ts in a second process: locked read-modify-writes of one JSON array.
import { openSecretStore } from './secretStore'

const main = async (): Promise<void> => {
  const [dir, profile, op, n] = process.argv.slice(2)
  const s = openSecretStore({ dir, profileDir: profile, lockWaitMs: 30_000 })
  for (let i = 0; i < Number(n); i++) {
    await s.withLock(async (tx) => {
      const list = JSON.parse((await tx.read('set.json')) ?? '[]') as string[]
      const next = op === 'add' ? [...list, `a${i}`] : list.filter((x) => x !== `r${i}`)
      await tx.write('set.json', JSON.stringify(next))
    })
  }
}
void main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
