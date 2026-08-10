/** The id marker for an account that exists only as a directory on disk, never in the registry.
 *  Registry ids are UUIDs, so no real account can collide with this prefix, and any code holding an id can
 *  tell the two apart without consulting a list.
 *
 *  This lives apart from ghosts.ts on purpose: building a ghost id needs node:path, and ghosts.ts also
 *  pulls in detect.ts (node:fs), so the renderer cannot import that module at all — tsconfig.web.json
 *  whitelists node-free core files one by one. The renderer only ever needs to *recognise* a ghost id, so
 *  that half is kept import-free and listed there. (Same reason core/resume.ts exists separately from
 *  rolling/config.ts.) */
export const GHOST_ID_PREFIX = 'ghost:'

export function isGhostAccountId(id: string): boolean {
  return id.startsWith(GHOST_ID_PREFIX)
}
