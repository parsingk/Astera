// Fields a person changed since a form opened (audit UI-7): a read that arrives after the change does not put the old
// value back over it.

export function createTouched(): { clear(): void; touch(key: string): void; unless(key: string, apply: () => void): void } {
  const touched = new Set<string>()
  return {
    clear: () => touched.clear(),
    touch: (key) => void touched.add(key),
    unless: (key, apply) => {
      if (!touched.has(key)) apply()
    }
  }
}
