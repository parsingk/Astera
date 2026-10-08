// A log kept to its newest part (audit UI-13): an installer printing progress bars grew the log without end, and every
// chunk copied all of it. Past `max` characters it keeps the tail, from a line start when there is one.

export function appendCapped(prev: string, text: string, max: number): string {
  const all = prev + text
  if (all.length <= max) return all
  const tail = all.slice(all.length - max)
  const nl = tail.indexOf('\n')
  return nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail
}
