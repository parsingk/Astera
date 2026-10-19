// The request as How It Works shows it (G8 demo). A record's `request` is what was asked, verbatim, and for a Job its
// objective. A Job made from a ticket has an objective Astera wrote (sources/objective.ts's sourcedObjective): a sentence
// naming the ticket, then the ticket's content quoted as data between SOURCE markers. That sentence is what was asked;
// the quoted content is the write-up's material, and the markers are for an agent, not a person. Pure; the app reads it.

/** sourcedObjective's shape: the sentence, a blank line, the line saying the content is data, the block with its tag,
 *  and the note a cut content gets. Anything else is a person's own words. */
const SOURCED = /^(Resolve [^\n]*)\n\n[^\n]*\n<<<SOURCE ([0-9a-f]{8})\n[\s\S]*\nSOURCE \2>>>(?:\n[^\n]*)?$/

export function requestShownOf(request: string): string {
  return SOURCED.exec(request)?.[1] ?? request
}
