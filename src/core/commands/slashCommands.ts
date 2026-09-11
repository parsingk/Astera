/** One thing `/` can start, as the composer's menu draws it. */
export interface SlashCommand {
  /** What goes on the line, without the leading slash: `report`, `superpowers:brainstorming`. */
  name: string
  /** The one-line description from the file's frontmatter, or '' when it has none. */
  description: string
  /** Where it came from, for the menu's right-hand label. */
  source: 'user' | 'project' | 'plugin'
}

/** The `description:` line of a markdown frontmatter block, or '' when there is none.
 *
 *  Deliberately not a YAML parser: the only field any of these files is read for is a single-line
 *  description, and every command and skill file measured on this machine writes it as one line. A
 *  folded or quoted multi-line description reads as its first line, which is what a one-line menu row
 *  would have shown anyway. */
export function frontmatterDescription(text: string): string {
  if (!text.startsWith('---')) return ''
  const end = text.indexOf('\n---', 3)
  const block = end === -1 ? text : text.slice(0, end)
  const m = /^description:\s*(.+)$/m.exec(block)
  if (m === null) return ''
  return m[1].trim().replace(/^["']|["']$/g, '')
}

/** Which of `commands` the text typed so far is asking for, or null when the menu does not belong.
 *
 *  `text` is the whole composer, and the menu only belongs on a line that *starts* a command: a `/`
 *  further in is a path or a date. Once a space has been typed the name is settled and the person is
 *  writing arguments, so the menu goes away rather than hovering over what they are typing.
 *
 *  Matching is a plain substring on the name, in the order the caller gave — the CLI's own menu
 *  narrows the same way, and a cleverer ranking would only disagree with it. */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  text: string
): SlashCommand[] | null {
  if (!text.startsWith('/')) return null
  const typed = text.slice(1)
  if (/\s/.test(typed)) return null
  const needle = typed.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().includes(needle))
}
