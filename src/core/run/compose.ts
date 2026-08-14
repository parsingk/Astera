// Docker Compose file discovery and service-name parsing. No node:* imports — the fs side (finding
// which of these names actually exists, reading it) lives in src/main/composeScanner.ts, the same
// split as jdk.ts/pythonScanner.ts.

/** Compose file name priority. Follows docker compose's own search order. */
export const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml'
] as const

/** Reads only the keys one level under `services:`.
 *  Why no YAML dependency: the only thing needed is the list of service names, and that always shows
 *  up as an indented key directly under `services:`. A parse miss just empties the service list and
 *  falls back to a whole-project run — a small, safe cost — so a real parser is not worth the
 *  dependency.
 *
 *  A first pass matched any line indented 1-4 spaces, which is wrong: a service's own body (`image:`,
 *  `ports:`, ...) is typically indented four spaces too, one level deeper than a two-space service key,
 *  so both fell inside that range and both got captured. The fix is to lock onto the indent width of
 *  the first key seen right after `services:` and only accept further lines at that exact width —
 *  anything deeper is a service's own content, not another service.
 *
 *  What this deliberately cannot read (documented rather than silently mishandled): a service key
 *  quoted ('web': or "web":), a service list whose members are not all indented identically, or a
 *  `services:` block reached through a YAML anchor/alias rather than written out literally. Each of
 *  those is a real compose file shape; on a mismatch this falls back to no service filter (or a
 *  shorter list), never to a wrong name. */
export function parseComposeServices(text: string): string[] {
  const out: string[] = []
  let inServices = false
  let serviceIndent: number | null = null
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue
    if (!inServices) {
      if (/^services\s*:/.test(raw)) inServices = true
      continue
    }
    const indent = /^\s*/.exec(raw)![0].length
    if (indent === 0) break // dedented back to top level — the services block is over
    if (serviceIndent === null) serviceIndent = indent
    if (indent < serviceIndent) break // shallower than the first service key — treat as the block ending
    if (indent > serviceIndent) continue // a service's own body (image:, ports:, ...), not another service
    const m = /^\s*([A-Za-z0-9._-]+)\s*:/.exec(raw)
    if (m) out.push(m[1])
  }
  return out
}
