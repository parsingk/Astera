/** `rec` without the keys in `gone`; the same object when none is there, so a state setter given it changes nothing
 *  (performance audit, renderer: per-session marks kept an entry for every session the app ever showed). */
export function dropKeys<T>(rec: Record<string, T>, gone: ReadonlySet<string>): Record<string, T> {
  let out: Record<string, T> | null = null
  for (const k of gone) {
    if (!(k in rec)) continue
    out ??= { ...rec }
    delete out[k]
  }
  return out ?? rec
}
