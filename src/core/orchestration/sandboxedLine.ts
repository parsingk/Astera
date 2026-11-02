// How a session in Claude Code's sandbox gets `astera` to the app (cli/run.ts sandboxedLine says why it cannot from inside):
// Astera's `excludedCommands` runs it outside the sandbox only as a command line of its own. Measured on a Mac with Claude
// Code 2.1.316 (2026-11-02): a line that pipes, redirects or feeds a heredoc into `astera` runs inside, so the reports the
// spec files asked for through stdin never arrived (the Mac check, checks 18 and 25). The spec files and the resume
// briefing say it beside their report command, as one paragraph so they cannot drift apart.

export const SANDBOXED_LINE_NOTE = `In a sandboxed Claude Code session \`astera\` reaches the app only as a command line of its own that
starts with \`astera\`: a line that pipes or redirects text into it (\`|\`, \`<\`, a heredoc), or starts
with anything else (\`"$ASTERA_CLI"\` included), runs inside the sandbox and reaches nothing. There,
give each \`-\` value inline in quotes instead, as \`--body "<three sentences>"\` (a quoted value may
span lines; inside double quotes the shell expands backticks and \`$\`).`
