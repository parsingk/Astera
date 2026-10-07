// Read-side checks for the secret store (remote runtime design §4.6, D5.3). `privateDirProblem` in
// `src/core/host/socketDir.ts` is the precedent; this extends it to files and to the walk up to the profile
// directory. Pure: the caller passes `lstat`, so the rules are tested on any OS.
import path from 'node:path'

export type StatLike = { isSymbolicLink(): boolean; isDirectory(): boolean; uid: number; mode: number }

/**
 * The file, then each directory above it, stopping short of the profile directory. The profile directory is the
 * user's own, may have been relocated by them, and is commonly 0755, so it is not walked (Phase 2 ruling).
 */
export function pathChain(file: string, profileDir: string): string[] {
  const root = path.resolve(profileDir)
  const rel = path.relative(root, path.resolve(file))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is not inside ${profileDir}`)
  const chain: string[] = []
  let p = path.resolve(file)
  for (let depth = rel.split(path.sep).length; depth > 0; depth--) {
    chain.push(p)
    p = path.dirname(p)
  }
  return chain
}

export function symlinkProblem(chain: string[], lstat: (p: string) => StatLike): string | null {
  for (const p of chain) if (lstat(p).isSymbolicLink()) return `${p} is a symbolic link or junction`
  return null
}

/** The file and the store directory: nobody else at all. Directories above them: nobody else may write. */
export function posixProblem(chain: string[], lstat: (p: string) => StatLike, uid: number): string | null {
  for (const [i, p] of chain.entries()) {
    const st = lstat(p)
    if (st.isSymbolicLink()) return `${p} is a symbolic link`
    if (st.uid !== uid) return `${p} is owned by uid ${st.uid}, not this user`
    const forbidden = i < 2 ? 0o077 : 0o022
    if ((st.mode & forbidden) !== 0)
      return `${p} has mode ${(st.mode & 0o777).toString(8)}, which ${i < 2 ? 'lets other users in' : 'is group or other writable'}`
  }
  return null
}
