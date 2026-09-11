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
 *  What matches, and in what order: a name that *starts* with what has been typed comes first, then
 *  one that merely contains it. Typing `b` should put `brainstorming` at the top rather than bury it
 *  under everything with a b in the middle, and the row Enter takes is the first row — so the order
 *  is not decoration, it decides what a person gets for pressing return. Ties keep the caller's own
 *  order, which is the project's commands, then the person's, then plugins. */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  text: string
): SlashCommand[] | null {
  if (!text.startsWith('/')) return null
  const typed = text.slice(1)
  if (/\s/.test(typed)) return null
  const needle = typed.toLowerCase()
  const starts: SlashCommand[] = []
  const contains: SlashCommand[] = []
  for (const command of commands) {
    const name = command.name.toLowerCase()
    if (name.startsWith(needle)) starts.push(command)
    else if (name.includes(needle)) contains.push(command)
  }
  return [...starts, ...contains]
}
