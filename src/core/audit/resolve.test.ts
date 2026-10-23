import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { resolveAction, redactTarget, type AuditAction } from './resolve'

// Paths are built with node:path so the same tests hold on win32 and POSIX.
const cwd = path.resolve('/work/proj')
const inProj = (...p: string[]): string => path.join(cwd, ...p)
const elsewhere = (...p: string[]): string => path.resolve(cwd, '..', 'elsewhere', ...p)

const claude = (tool: string, input: unknown) => resolveAction({ provider: 'claude', tool, input, cwd })
const codex = (tool: string, input: unknown, at: string = cwd) => resolveAction({ provider: 'codex', tool, input, cwd: at })
const bash = (command: string) => claude('Bash', { command })
const ps = (command: string) => claude('PowerShell', { command })
/** The actions of a result's commands, without the place each one has. */
const acts = (r: { commands?: Array<{ action: AuditAction }> }) => r.commands?.map((c) => c.action)

describe('shell: the action comes from the first words', () => {
  it('names git push a remote write, with the program and first subcommand as target', () => {
    expect(bash('git push origin main')).toEqual({ action: 'git.remote.write', target: 'git push', confidence: 'high' })
  })

  it('looks past git global options and a program path with .exe', () => {
    expect(bash('git -C ../other push')).toMatchObject({ action: 'git.remote.write', target: 'git push' })
    expect(bash('git -c core.pager=cat --no-pager log')).toMatchObject({ action: 'git.read', target: 'git log' })
    expect(bash('"C:\\Program Files\\Git\\bin\\git.exe" status')).toMatchObject({ action: 'git.read', target: 'git status' })
    expect(bash('/usr/bin/git push')).toMatchObject({ action: 'git.remote.write', target: 'git push' })
  })

  it.each([
    ['git status', 'git.read'],
    ['git log --oneline -5', 'git.read'],
    ['git diff HEAD~1', 'git.read'],
    ['git show abc1234', 'git.read'],
    ['git check-ignore -v build', 'git.read'],
    ['git ls-remote origin', 'git.read'],
    ['git commit -m "x"', 'git.local.write'],
    ['git add -A', 'git.local.write'],
    ['git checkout -b feature', 'git.local.write'],
    ['git merge develop', 'git.local.write'],
    ['git push', 'git.remote.write']
  ] satisfies Array<[string, AuditAction]>)('%s is %s', (command, action) => {
    expect(bash(command)).toMatchObject({ action, confidence: 'high' })
  })

  it('treats a git subcommand it does not know as unknown rather than guessing', () => {
    expect(bash('git pushf')).toMatchObject({ action: 'process.execute', target: 'git pushf', confidence: 'unknown' })
  })

  it.each([
    ['gh pr create --title "x" --body "y"', 'github.pr.create'],
    ['gh issue create --title x', 'github.write'],
    ['gh pr merge 12 --squash', 'github.write'],
    ['gh release create v1.0.0', 'github.write'],
    ['gh api -X POST repos/o/r/issues -f title=x', 'github.write'],
    ['gh api repos/o/r/issues --method DELETE', 'github.write'],
    ['gh pr view 12', 'process.execute'],
    ['gh api repos/o/r/pulls', 'process.execute'],
    ['gh api repos/o/r/pulls --method GET -f state=open', 'process.execute']
  ] satisfies Array<[string, AuditAction]>)('%s is %s', (command, action) => {
    expect(bash(command)).toMatchObject({ action, confidence: 'high' })
  })

  it('keeps gh to the program and its first subcommand', () => {
    expect(bash('gh pr create --title "secret title"').target).toBe('gh pr')
  })

  it.each([
    ['npm install', 'package.install'],
    ['npm i left-pad', 'package.install'],
    ['npm ci', 'package.install'],
    ['pnpm add zod', 'package.install'],
    ['yarn', 'package.install'],
    ['yarn add react', 'package.install'],
    ['pip install requests', 'package.install'],
    ['python -m pip install requests', 'package.install'],
    ['uv pip install requests', 'package.install'],
    ['cargo install ripgrep', 'package.install'],
    ['npm test', 'process.execute'],
    ['npm run build', 'process.execute'],
    ['yarn test', 'process.execute']
  ] satisfies Array<[string, AuditAction]>)('%s is %s', (command, action) => {
    expect(bash(command)).toMatchObject({ action, confidence: 'high' })
  })

  it('shows npm test as npm test and npm run build as npm run', () => {
    expect(bash('npm test').target).toBe('npm test')
    expect(bash('npm run build').target).toBe('npm run')
    expect(bash('npx vitest run src/a.test.ts').target).toBe('npx vitest')
  })

  it('names a plain ordinary command process.execute at high confidence', () => {
    expect(bash('node scripts/build.js')).toEqual({ action: 'process.execute', target: 'node', confidence: 'high' })
    expect(bash('chmod +x run.sh')).toMatchObject({ action: 'process.execute', target: 'chmod', confidence: 'high' })
  })

  it('ignores a leading comment line and environment assignments', () => {
    expect(bash('# check the tree\ngit status')).toMatchObject({ action: 'git.read', confidence: 'high' })
    expect(bash('NODE_ENV=test CI=1 npm test')).toMatchObject({ target: 'npm test', confidence: 'high' })
  })

  it('does not take the 2>&1 of a redirection for a second command, and sees the file it writes', () => {
    expect(bash('npm test > out.log 2>&1')).toEqual({
      action: 'process.execute',
      target: 'npm test',
      confidence: 'heuristic', // two entries in commands: at most heuristic
      commands: [{ action: 'process.execute' }, { action: 'filesystem.write', insideProject: true }]
    })
    expect(bash('npm test 2>&1')).toEqual({ action: 'process.execute', target: 'npm test', confidence: 'high' })
  })
})

describe('shell: deleting and reading files', () => {
  it('maps rm, del and Remove-Item to filesystem.delete and keeps the program as target', () => {
    expect(bash('rm -rf build')).toEqual({
      action: 'filesystem.delete', target: 'rm', insideProject: true, confidence: 'high'
    })
    expect(claude('PowerShell', { command: 'Remove-Item -Recurse -Force dist' })).toEqual({
      action: 'filesystem.delete', target: 'Remove-Item', insideProject: true, confidence: 'high'
    })
    expect(bash('del /q build.log')).toMatchObject({ action: 'filesystem.delete', target: 'del', insideProject: true })
  })

  it('says a delete outside the folder is outside, including when one of several paths is', () => {
    expect(bash(`rm -rf "${elsewhere('old')}"`)).toMatchObject({ action: 'filesystem.delete', insideProject: false })
    expect(bash('rm -rf ../old')).toMatchObject({ insideProject: false })
    expect(bash(`rm a.txt "${elsewhere('b.txt')}"`)).toMatchObject({ insideProject: false })
    expect(bash('rm -rf ~/old')).toMatchObject({ insideProject: false })
    expect(bash('rm -rf $HOME/old')).toMatchObject({ insideProject: false })
  })

  it('does not mistake the value of a PowerShell parameter for the path', () => {
    expect(
      claude('PowerShell', { command: `Remove-Item -ErrorAction SilentlyContinue "${elsewhere('x')}"` })
    ).toMatchObject({ action: 'filesystem.delete', insideProject: false })
  })

  it('leaves insideProject out when a delete names no path', () => {
    expect(bash('rm')).not.toHaveProperty('insideProject')
  })

  it('maps cat, head and Get-Content to filesystem.read with a path target', () => {
    expect(bash('cat src/a.ts')).toEqual({
      action: 'filesystem.read', target: 'src/a.ts', insideProject: true, confidence: 'high'
    })
    expect(bash('head -n 5 src/a.ts')).toMatchObject({ action: 'filesystem.read', target: 'src/a.ts' })
    expect(claude('PowerShell', { command: 'Get-Content -Path src/a.ts -TotalCount 5' })).toMatchObject({
      action: 'filesystem.read', target: 'src/a.ts', insideProject: true
    })
    expect(bash('cat src/a.ts src/b.ts')).toMatchObject({ target: 'src/a.ts (+1)' })
  })

  it('names a read outside the folder by its file name only', () => {
    expect(bash('cat ../secret.txt')).toEqual({
      action: 'filesystem.read', target: 'outside project: secret.txt', insideProject: false, confidence: 'high'
    })
  })

  it('reads the folder itself for a bare ls, and is a plain command for a bare cat', () => {
    expect(bash('ls -la')).toMatchObject({ action: 'filesystem.read', target: '.', insideProject: true })
    expect(bash('cat')).toMatchObject({ action: 'process.execute', target: 'cat' })
  })
})

describe('shell: network', () => {
  it('maps curl, wget and Invoke-WebRequest to network.request with the host name only', () => {
    expect(bash('curl -s https://api.example.com/v1/items?page=2')).toEqual({
      action: 'network.request', target: 'api.example.com', confidence: 'high'
    })
    expect(bash('wget -q "http://files.example.org:8080/a.zip"').target).toBe('files.example.org')
    expect(claude('PowerShell', { command: 'Invoke-WebRequest -Uri https://a.example.net/x -OutFile y' }).target).toBe(
      'a.example.net'
    )
    expect(claude('PowerShell', { command: 'iwr https://b.example.net/y' })).toMatchObject({ action: 'network.request' })
  })

  it('falls back to the program when no URL is in the line', () => {
    expect(bash('curl localhost:3000/health')).toMatchObject({ action: 'network.request', target: 'curl' })
  })
})

describe('shell: compound lines are heuristic and list every command', () => {
  it('classifies npm test && git push by its first command and lists both', () => {
    expect(bash('npm test && git push')).toEqual({
      action: 'process.execute',
      target: 'npm test',
      confidence: 'heuristic',
      commands: [{ action: 'process.execute' }, { action: 'git.remote.write' }]
    })
  })

  it.each([
    ['cd src; ls', ['process.execute', 'filesystem.read']],
    ['git status | head -5', ['git.read', 'process.execute']],
    ['git fetch || git pull', ['git.local.write']],
    ['npm run build & npm run lint', ['process.execute']],
    ['echo a\ngit log\nnpm test', ['process.execute', 'git.read']]
  ] satisfies Array<[string, AuditAction[]]>)('splits %j and lists %j without repeats', (command, actions) => {
    const r = bash(command)
    expect(r.confidence).toBe('heuristic')
    expect(acts(r)).toEqual(actions)
  })

  it('keeps two commands of one action apart when they act in different places', () => {
    expect(bash('rm a.txt && rm b.txt').commands).toEqual([{ action: 'filesystem.delete', insideProject: true }])
    expect(bash('rm a.txt && rm ../b.txt').commands).toEqual([
      { action: 'filesystem.delete', insideProject: true },
      { action: 'filesystem.delete', insideProject: false }
    ])
  })

  it('gives the headline command its own place, not the worst of the line', () => {
    const r = bash('rm -rf build && cat ../notes.txt')
    expect(r).toMatchObject({ action: 'filesystem.delete', insideProject: true })
    expect(r.commands).toEqual([
      { action: 'filesystem.delete', insideProject: true },
      { action: 'filesystem.read', insideProject: false }
    ])
  })

  it('does not split on operators inside quotes', () => {
    expect(bash('git commit -m "fix a && b; c | d"')).toEqual({
      action: 'git.local.write', target: 'git commit', confidence: 'high'
    })
    expect(bash("git commit -m 'one; two'")).toMatchObject({ confidence: 'high' })
  })

  it('does not read the body of a heredoc as commands', () => {
    const r = bash("git commit -F - <<'EOF'\nsubject && git push\nEOF")
    expect(r).toEqual({ action: 'git.local.write', target: 'git commit', confidence: 'high' })
  })

  it('sees the command inside $( ) and ( ) groups', () => {
    expect(acts(bash('echo $(git push)'))).toEqual(['process.execute', 'git.remote.write'])
    expect(acts(bash('(cd x && git push)'))).toEqual(['process.execute', 'git.remote.write'])
  })

  it('sees the commands in a PowerShell script block, each with its own place', () => {
    const r = ps('Get-ChildItem | ForEach-Object { Remove-Item $_ }')
    expect(r.confidence).toBe('heuristic')
    expect(r.commands).toEqual([
      { action: 'filesystem.read', insideProject: true },
      { action: 'process.execute' },
      { action: 'filesystem.delete', insideProject: false } // $_ cannot be shown to be inside
    ])
    expect(r.insideProject).toBe(true) // the headline, Get-ChildItem, reads the folder itself
  })

  it('gives a single command no commands list', () => {
    expect(bash('git push')).not.toHaveProperty('commands')
  })
})

// Measured on 6,814 real Bash and PowerShell calls: assignment-only commands, control-flow words and a leading cd were
// the bulk of what made lines unknown or gave them a useless headline.
describe('shell: syntax that is not a command', () => {
  it('drops assignment-only commands, which run nothing', () => {
    expect(bash('BRANCH=main; git push origin $BRANCH')).toEqual({
      action: 'git.remote.write', target: 'git push', confidence: 'high'
    })
    expect(acts(bash('SHA=$(git rev-parse HEAD) && git push'))).toEqual(['git.read', 'git.remote.write'])
  })

  it('reads the commands inside a loop or a conditional and calls the line heuristic', () => {
    expect(bash('for f in a b; do git push; done')).toEqual({
      action: 'git.remote.write',
      target: 'git push',
      confidence: 'heuristic',
      commands: [{ action: 'git.remote.write' }]
    })
    const r = bash('if [ -f x ]; then cat x; else rm -rf y; fi')
    expect(r.confidence).toBe('heuristic')
    expect(acts(r)).toEqual(['process.execute', 'filesystem.read', 'filesystem.delete'])
  })

  it('drops PowerShell variable and environment assignments, keeping the command an assignment holds', () => {
    expect(ps("$env:CI='1'; npm test")).toEqual({ action: 'process.execute', target: 'npm test', confidence: 'high' })
    expect(ps('$x = Get-Content a.txt')).toMatchObject({ action: 'filesystem.read', target: 'a.txt', confidence: 'high' })
    expect(ps("$env:A='b'; $env:B='c'; git push")).toMatchObject({ action: 'git.remote.write', confidence: 'high' })
  })

  it('reads through timeout and its duration', () => {
    expect(bash('timeout 30 npm test')).toEqual({ action: 'process.execute', target: 'npm test', confidence: 'high' })
    expect(bash('timeout -s KILL 5 git push')).toMatchObject({ action: 'git.remote.write', confidence: 'high' })
  })

  it('treats the verbs PowerShell reserves for reading as known', () => {
    const r = ps('Get-Service | Where-Object Status -eq Running | Format-Table | Out-String')
    expect(r).toMatchObject({ action: 'process.execute', confidence: 'heuristic' })
    expect(acts(r)).toEqual(['process.execute'])
  })
})

describe('shell: cd', () => {
  it('does not headline a line with its leading cd', () => {
    expect(bash('cd src && npm test')).toEqual({
      action: 'process.execute', target: 'npm test', confidence: 'heuristic', commands: [{ action: 'process.execute' }]
    })
    expect(bash('cd src && git push')).toMatchObject({ action: 'git.remote.write', target: 'git push' })
    expect(bash('cd src')).toMatchObject({ target: 'cd', confidence: 'high' })
  })

  it('measures what follows a cd from where it went', () => {
    expect(bash('cd src && rm -rf build')).toMatchObject({ action: 'filesystem.delete', insideProject: true })
    expect(bash('cd .. && rm -rf build')).toMatchObject({ insideProject: false })
    expect(bash(`cd "${elsewhere()}" && cat a.txt`)).toMatchObject({
      action: 'filesystem.read', target: 'outside project: a.txt', insideProject: false
    })
    expect(bash(`cd "${elsewhere()}" && cd "${inProj('src')}" && cat a.txt`)).toMatchObject({
      target: 'src/a.txt', insideProject: true
    })
  })

  it('cannot follow a cd to home, a variable or nowhere, so a relative path after it is not shown to be inside', () => {
    expect(bash('cd ~ && rm -rf x')).toMatchObject({ insideProject: false })
    expect(bash('cd $DIR && rm -rf x')).toMatchObject({ insideProject: false })
    expect(bash('cd && rm -rf x')).toMatchObject({ insideProject: false })
    expect(bash('cd $DIR && rm -rf /nowhere/x')).toMatchObject({ insideProject: false })
    expect(bash(`cd $DIR && rm -rf "${inProj('x')}"`)).toMatchObject({ insideProject: true })
  })
})

describe('shell: unknown', () => {
  it('is unknown for a program it has no row for', () => {
    expect(bash('foo-bar.sh')).toEqual({ action: 'process.execute', target: 'foo-bar.sh', confidence: 'unknown' })
  })

  it('shows only the file name of a script run by path', () => {
    expect(bash('./scripts/deploy.sh --prod')).toMatchObject({ target: 'deploy.sh', confidence: 'unknown' })
  })

  it('is unknown for a line with one unknown command among known ones', () => {
    expect(bash('npm test && ./foo.sh')).toEqual({
      action: 'process.execute',
      target: 'npm test',
      confidence: 'unknown',
      commands: [{ action: 'process.execute' }]
    })
  })

  it('is unknown for a shell running a script file, an empty line, or a word that is no program', () => {
    expect(bash('bash deploy.sh')).toMatchObject({ confidence: 'unknown' })
    expect(bash('')).toEqual({ action: 'process.execute', target: 'shell', confidence: 'unknown' })
    expect(bash('$(whoami)')).toMatchObject({ confidence: 'unknown' })
  })
})

describe('shell: wrappers', () => {
  it('reads the script inside bash -lc, powershell -Command and cmd /c', () => {
    expect(bash('bash -lc "git push origin main"')).toMatchObject({ action: 'git.remote.write', confidence: 'high' })
    expect(
      claude('PowerShell', { command: 'powershell.exe -NoProfile -Command "git push"' })
    ).toMatchObject({ action: 'git.remote.write', confidence: 'high' })
    expect(bash('cmd /c "git push"')).toMatchObject({ action: 'git.remote.write' })
  })

  it('makes a wrapped compound line compound', () => {
    expect(bash("sh -c 'npm test && git push'")).toMatchObject({
      confidence: 'heuristic', commands: [{ action: 'process.execute' }, { action: 'git.remote.write' }]
    })
  })

  it('skips sudo and env', () => {
    expect(bash('sudo npm install -g x')).toMatchObject({ action: 'package.install' })
    expect(bash('env FOO=1 git push')).toMatchObject({ action: 'git.remote.write' })
  })
})

describe('files, structured tools', () => {
  it('maps Read to filesystem.read, exact, with a path relative to the session folder', () => {
    expect(claude('Read', { file_path: inProj('src', 'a.ts') })).toEqual({
      action: 'filesystem.read', target: 'src/a.ts', insideProject: true, confidence: 'exact'
    })
  })

  it('names a path outside the folder by its file name only', () => {
    expect(claude('Read', { file_path: elsewhere('notes.md') })).toEqual({
      action: 'filesystem.read', target: 'outside project: notes.md', insideProject: false, confidence: 'exact'
    })
  })

  it('maps Write ../x.ts from the session folder to outside the project', () => {
    expect(claude('Write', { file_path: '../x.ts', content: 'secret body' })).toEqual({
      action: 'filesystem.write', target: 'outside project: x.ts', insideProject: false, confidence: 'exact'
    })
  })

  it('keeps a sibling folder with the same prefix outside', () => {
    expect(claude('Write', { file_path: `${cwd}2${path.sep}a.ts` })).toMatchObject({ insideProject: false })
  })

  it.each([
    ['Edit', { file_path: inProj('a.ts'), old_string: 'x', new_string: 'y' }],
    ['MultiEdit', { file_path: inProj('a.ts'), edits: [] }],
    ['NotebookEdit', { notebook_path: inProj('a.ipynb'), new_source: 'x' }]
  ])('maps %s to filesystem.write', (tool, input) => {
    expect(claude(tool, input)).toMatchObject({ action: 'filesystem.write', insideProject: true, confidence: 'exact' })
  })

  it('never puts file contents in the target', () => {
    const r = claude('Write', { file_path: inProj('a.ts'), content: 'const k = "sk-abcdefghijklmnopqrstuvwx"' })
    expect(JSON.stringify(r)).not.toContain('sk-')
  })

  it('maps Grep and Glob to filesystem.read of their folder, the session folder by default', () => {
    expect(claude('Grep', { pattern: 'TODO' })).toEqual({
      action: 'filesystem.read', target: '.', insideProject: true, confidence: 'exact'
    })
    expect(claude('Glob', { pattern: '**/*.ts', path: inProj('src') })).toMatchObject({ target: 'src', insideProject: true })
    expect(claude('Grep', { pattern: 'x', path: elsewhere() })).toMatchObject({
      target: 'outside project: elsewhere', insideProject: false
    })
  })

  it('reads an absolute Glob pattern as a read of its fixed part when no path is given', () => {
    expect(claude('Glob', { pattern: path.join(elsewhere(), '**', '*.ts') })).toEqual({
      action: 'filesystem.read', target: 'outside project: elsewhere', insideProject: false, confidence: 'exact'
    })
    expect(claude('Glob', { pattern: path.join(inProj('src'), '*.ts') })).toMatchObject({ target: 'src', insideProject: true })
    expect(claude('Glob', { pattern: '**/*.ts' })).toMatchObject({ target: '.' })
  })

  it('is unknown, not a guess, when a file tool carries no readable path', () => {
    expect(claude('Write', {})).toEqual({ action: 'filesystem.write', target: 'Write', confidence: 'unknown' })
    expect(claude('Read', 'not an object')).toMatchObject({ action: 'filesystem.read', confidence: 'unknown' })
  })

  it.runIf(process.platform === 'win32')('compares paths without case on win32', () => {
    expect(claude('Write', { file_path: inProj('A.ts').toUpperCase() })).toMatchObject({ insideProject: true })
  })

  it.runIf(process.platform === 'win32')('reads a Git Bash drive path like /c/work as C:/work', () => {
    const msys = `/${cwd[0].toLowerCase()}${cwd.slice(2).split(path.sep).join('/')}/src/a.ts`
    expect(bash(`cat ${msys}`)).toMatchObject({ target: 'src/a.ts', insideProject: true })
    expect(claude('Read', { file_path: msys })).toMatchObject({ target: 'src/a.ts', insideProject: true })
  })
})

describe('web, MCP, agents, anything else', () => {
  it('maps WebFetch to the host name only', () => {
    expect(claude('WebFetch', { url: 'https://a.example.com/x?q', prompt: 'summarise' })).toEqual({
      action: 'network.request', target: 'a.example.com', confidence: 'exact'
    })
  })

  it('drops credentials and port from the host', () => {
    expect(claude('WebFetch', { url: 'https://user:pw@h.example.com:8443/p' }).target).toBe('h.example.com')
  })

  it('keeps the search text out of a WebSearch record', () => {
    expect(claude('WebSearch', { query: 'how to rotate sk-abcdefghijklmnopqrstuvwx' })).toEqual({
      action: 'network.request', target: 'web search', confidence: 'exact'
    })
  })

  it('is unknown for a WebFetch with no usable URL', () => {
    expect(claude('WebFetch', { url: 'not a url' })).toMatchObject({ action: 'network.request', confidence: 'unknown' })
  })

  it('maps mcp__server__tool to mcp.call with server.tool, whatever the input', () => {
    expect(claude('mcp__github__create_issue', { title: 'x', body: 'token=abcdef' })).toEqual({
      action: 'mcp.call', target: 'github.create_issue', confidence: 'exact'
    })
    expect(claude('mcp__claude_ai_Claude_Docs__batch', {}).target).toBe('claude_ai_Claude_Docs.batch')
    expect(claude('mcp__a__b__c', {}).target).toBe('a.b__c')
  })

  it('is other for a malformed MCP name', () => {
    expect(claude('mcp__github', {})).toMatchObject({ action: 'other', target: 'mcp__github', confidence: 'unknown' })
  })

  it('maps Agent and Task to agent.spawn with no target', () => {
    expect(claude('Agent', { description: 'x', prompt: 'y' })).toEqual({ action: 'agent.spawn', target: '', confidence: 'exact' })
    expect(claude('Task', { prompt: 'y' })).toMatchObject({ action: 'agent.spawn', target: '' })
  })

  it('is other, unknown, for a tool it has no row for, named by the tool', () => {
    expect(claude('SomeNewTool', { x: 1 })).toEqual({ action: 'other', target: 'SomeNewTool', confidence: 'unknown' })
  })

  it('does not take a Codex tool name for a Claude tool', () => {
    expect(claude('shell_command', { command: 'git push' })).toMatchObject({ action: 'other' })
    expect(codex('Bash', { command: 'git push' })).toMatchObject({ action: 'other' })
  })
})

describe('Codex', () => {
  it('reads shell_command arguments given as the JSON string the rollout holds', () => {
    expect(codex('shell_command', '{"command":"npm run build","workdir":"/w/demo","timeout_ms":120000}')).toEqual({
      action: 'process.execute', target: 'npm run', confidence: 'high'
    })
  })

  it('reads exec_command cmd, as object or JSON string', () => {
    expect(codex('exec_command', { cmd: 'git push origin main' })).toMatchObject({ action: 'git.remote.write' })
    expect(codex('exec_command', '{"cmd":"git log -1"}')).toMatchObject({ action: 'git.read' })
  })

  it('reads a command given as an argv array, unwrapping bash -lc', () => {
    expect(codex('shell', { command: ['bash', '-lc', 'git push origin main'] })).toMatchObject({
      action: 'git.remote.write', confidence: 'high'
    })
    expect(codex('shell', { command: ['git', 'status'] })).toMatchObject({ action: 'git.read' })
    expect(codex('local_shell', { command: ['bash', '-lc', 'npm test && git push'] })).toMatchObject({
      confidence: 'heuristic', commands: [{ action: 'process.execute' }, { action: 'git.remote.write' }]
    })
  })

  it('measures a relative path from the call workdir, not the session folder', () => {
    expect(codex('shell_command', { command: 'cat package.json', workdir: elsewhere() })).toMatchObject({
      action: 'filesystem.read', target: 'outside project: package.json', insideProject: false
    })
    expect(codex('shell_command', { command: 'cat package.json', workdir: inProj('sub') })).toMatchObject({
      target: 'sub/package.json', insideProject: true
    })
  })

  it('lists the first of two apply_patch files and a count', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: src/b.ts',
      '+body that must not be recorded',
      '*** End Patch'
    ].join('\n')
    const expected = { action: 'filesystem.write', target: 'src/a.ts (+1)', insideProject: true, confidence: 'exact' }
    expect(codex('apply_patch', patch)).toEqual(expected)
    expect(codex('apply_patch', { input: patch })).toEqual(expected)
    expect(codex('apply_patch', JSON.stringify({ input: patch }))).toEqual(expected)
  })

  it('counts a Move to destination and a Delete File, and flags one outside', () => {
    const patch = [
      '*** Begin Patch',
      '*** Delete File: src/old.ts',
      '*** Update File: src/a.ts',
      '*** Move to: ../moved.ts',
      '*** End Patch'
    ].join('\n')
    expect(codex('apply_patch', patch)).toMatchObject({
      action: 'filesystem.write', target: 'src/old.ts (+2)', insideProject: false
    })
  })

  it('is unknown for an apply_patch with no file header', () => {
    expect(codex('apply_patch', '*** Begin Patch\n*** End Patch')).toEqual({
      action: 'filesystem.write', target: 'apply_patch', confidence: 'unknown'
    })
  })

  it('maps web search to network.request without the query', () => {
    expect(codex('web_search', { action: { type: 'search', query: 'ts2345 meaning' } })).toEqual({
      action: 'network.request', target: 'web search', confidence: 'exact'
    })
    expect(codex('web_search_call', { action: { query: 'x' } })).toMatchObject({ action: 'network.request' })
  })

  it('maps MCP and spawn_agent like Claude does', () => {
    expect(codex('mcp__github__create_issue', {})).toMatchObject({ action: 'mcp.call', target: 'github.create_issue' })
    expect(codex('spawn_agent', { message: 'x' })).toEqual({ action: 'agent.spawn', target: '', confidence: 'exact' })
  })
})

// codex 0.160 sends every tool through `exec`, whose input is a little script (measured on 4,392 real calls: 2,783
// start with exec_command, 720 with apply_patch, and 46% call more than one tool).
describe('Codex exec scripts', () => {
  const exec = (source: string, at: string = cwd) => codex('exec', source, at)

  it('reads the command of tools.exec_command, escapes included', () => {
    expect(exec('const r = await tools.exec_command({cmd:"git push origin main"}); text(r.output);\n')).toEqual({
      action: 'git.remote.write', target: 'git push', confidence: 'high'
    })
    expect(exec('text(await tools.exec_command({cmd:"git commit -m \\"a && b\\"",yield_time_ms:1000}));')).toEqual({
      action: 'git.local.write', target: 'git commit', confidence: 'high'
    })
  })

  it('measures a relative path from the call workdir', () => {
    const source = `text(await tools.exec_command({cmd:"cat package.json","workdir":${JSON.stringify(elsewhere())}}));`
    expect(exec(source)).toMatchObject({ action: 'filesystem.read', target: 'outside project: package.json', insideProject: false })
  })

  it('reads the patch of tools.apply_patch', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch'
    expect(exec(`await tools.apply_patch(${JSON.stringify(patch)});`)).toEqual({
      action: 'filesystem.write', target: 'src/a.ts (+1)', insideProject: true, confidence: 'exact'
    })
  })

  it('names an MCP call from the tool name alone', () => {
    expect(exec('text(await tools.mcp__github__create_issue({title:"x",body:"token=abc123456"}));')).toEqual({
      action: 'mcp.call', target: 'github.create_issue', confidence: 'exact'
    })
  })

  it('maps view_image to a file read and web__run to a web request', () => {
    expect(exec('await tools.view_image({path:"src/a.png"});')).toEqual({
      action: 'filesystem.read', target: 'src/a.png', insideProject: true, confidence: 'exact'
    })
    expect(exec('await tools.web__run({search_query:[{q:"ts2345"}]});')).toEqual({
      action: 'network.request', target: 'web search', confidence: 'exact'
    })
  })

  it('treats a script that calls several tools as a compound line, headlined by the first', () => {
    expect(exec('await tools.exec_command({cmd:"git status"}); await tools.exec_command({cmd:"git push"});')).toEqual({
      action: 'git.read',
      target: 'git status',
      confidence: 'heuristic',
      commands: [{ action: 'git.read' }, { action: 'git.remote.write' }]
    })
    const r = exec('await tools.view_image({path:"../x.png"}); await tools.exec_command({cmd:"npm test && git push"});')
    expect(r).toMatchObject({ insideProject: false })
    expect(r.commands).toEqual([
      { action: 'filesystem.read', insideProject: false },
      { action: 'process.execute' },
      { action: 'git.remote.write' }
    ])
  })

  it('is unknown for a tool it has no row for, a command it cannot read, or a script with no tool call', () => {
    expect(exec('await tools.image_gen__imagegen({prompt:"x"});')).toEqual({
      action: 'other', target: 'image_gen__imagegen', confidence: 'unknown'
    })
    expect(exec('await tools.exec_command({cmd:`git push`});')).toEqual({
      action: 'process.execute', target: 'shell', confidence: 'unknown'
    })
    expect(exec('const x = 1;')).toEqual({ action: 'other', target: 'exec', confidence: 'unknown' })
  })

  it('reads view_image sent as a plain function call', () => {
    expect(codex('view_image', '{"path":"../x.png"}')).toMatchObject({
      action: 'filesystem.read', target: 'outside project: x.png', insideProject: false
    })
  })

  it('does not read a tools.name( inside a string or a comment as a call', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-x',
      '+const r = this.tools.get(name)',
      '+// tools.exec_command({cmd:"git push"})',
      '*** End Patch'
    ].join('\n')
    expect(exec(`await tools.apply_patch(${JSON.stringify(patch)})`)).toEqual({
      action: 'filesystem.write', target: 'src/a.ts', insideProject: true, confidence: 'exact'
    })
    expect(exec('await tools.exec_command({cmd:"rg -n \\"tools.exec_command(\\" src"})')).toEqual({
      action: 'filesystem.read', target: 'src', insideProject: true, confidence: 'high'
    })
    expect(exec('// tools.exec_command({cmd:"git push"})\nawait tools.exec_command({cmd:"git status"})')).toEqual({
      action: 'git.read', target: 'git status', confidence: 'high'
    })
    expect(
      exec("const note = 'tools.exec_command(x)'; /* tools.exec_command() */ await tools.exec_command({cmd:\"git log\"});")
    ).toEqual({ action: 'git.read', target: 'git log', confidence: 'high' })
  })

  it('keeps a token in an exec script out of the target', () => {
    const r = exec('await tools.exec_command({cmd:"curl -H \\"Authorization: Bearer abc123def456\\" https://api.example.com/x"});')
    expect(JSON.stringify(r)).not.toContain('abc123def456')
    expect(r.target).toBe('api.example.com')
  })
})

// Fix round 1 (review): what a quoted word, a home path, a redirection or a pipe into a writer hides from a rule.
describe('shell: a quoted first word is not a program', () => {
  it.each([`'myS3cretPass' | docker login --password-stdin`, `"myS3cretPass" | docker login --password-stdin`])(
    '%s leaves no trace of the word in the record',
    (line) => {
      for (const r of [bash(line), ps(line)]) expect(JSON.stringify(r)).not.toContain('myS3cretPass')
      // Bash runs a quoted word, so it is an unknown program; PowerShell never does, so it is data and the pipe's real command headlines.
      expect(bash(line)).toMatchObject({ action: 'process.execute', target: 'shell', confidence: 'unknown' })
      expect(ps(line)).toMatchObject({ action: 'process.execute', target: 'docker login', confidence: 'heuristic' })
    }
  )

  it('still reads a quoted path to a program, and a quoted name after the call operator', () => {
    expect(bash('"/usr/bin/git" push')).toMatchObject({ action: 'git.remote.write', confidence: 'high' })
    expect(ps("& 'git' push")).toMatchObject({ action: 'git.remote.write', confidence: 'high' })
    expect(ps('& $exe --version')).toMatchObject({ confidence: 'unknown' }) // a program picked by a variable is opaque
  })
})

describe('structured tools: a home path is not inside the project', () => {
  it.each([
    ['Write', { file_path: '~/x.ts' }],
    ['Read', { file_path: '~\\x.ts' }],
    ['Edit', { file_path: '~/notes/a.md', old_string: 'a', new_string: 'b' }],
    ['NotebookEdit', { notebook_path: '~/n.ipynb' }]
  ])('%s of %j is outside', (tool, input) => {
    expect(claude(tool, input)).toMatchObject({ insideProject: false })
    expect(claude(tool, input).target).toMatch(/^outside project: /)
  })

  it('treats view_image of a home path the same, and leaves look-alike names inside', () => {
    expect(codex('view_image', { path: '~/x.png' })).toMatchObject({ insideProject: false })
    expect(claude('Write', { file_path: '~$draft.docx' })).toMatchObject({ insideProject: true }) // a Word lock file
    expect(claude('Read', { file_path: inProj('$x', 'a.ts') })).toMatchObject({ insideProject: true }) // $ is literal here
  })
})

describe('shell: writing and deleting files beyond rm', () => {
  it('sees what a redirection writes, with its own place', () => {
    expect(bash('echo x > ../outside.txt')).toEqual({
      action: 'filesystem.write',
      target: 'outside project: outside.txt',
      insideProject: false,
      confidence: 'heuristic',
      commands: [{ action: 'process.execute' }, { action: 'filesystem.write', insideProject: false }]
    })
    expect(bash('printf a >> notes/log.txt')).toMatchObject({ action: 'filesystem.write', target: 'notes/log.txt', insideProject: true })
    expect(bash("cat > notes.md <<'EOF'\nbody && git push\nEOF")).toMatchObject({
      action: 'filesystem.write', target: 'notes.md', insideProject: true
    })
    expect(bash('> out.txt')).toEqual({
      action: 'filesystem.write', target: 'out.txt', insideProject: true, confidence: 'high'
    })
  })

  it('does not count the sinks that discard output, copy a stream, or read input', () => {
    for (const line of ['ls 2>/dev/null', 'ls > /dev/null 2>&1', 'ls >&2', 'ls 2>&1', 'ls < in.txt', 'ls > nul', 'ls 2> NUL']) {
      expect(bash(line).commands).toBeUndefined()
    }
    expect(ps('Get-ChildItem > $null').commands).toBeUndefined()
  })

  it('does not show a redirection to a variable as inside', () => {
    expect(bash('echo x > "$OUT"')).toMatchObject({ action: 'filesystem.write', insideProject: false })
  })

  it.each([
    ['cp a.txt ../outside/', 'outside project: outside', false],
    ['mv a.txt ../outside/', 'outside project: outside', false],
    ['cp -r a b', 'b', true],
    ['cp -t ../elsewhere a b', 'outside project: elsewhere', false],
    ['cp --target-directory=sub a', 'sub', true],
    ['cp a.txt "$DEST"', 'outside project: $DEST', false]
  ])('%s writes %s', (line, target, insideProject) => {
    expect(bash(line)).toEqual({ action: 'filesystem.write', target, insideProject, confidence: 'high' })
  })

  it('is unknown when a copy names no destination', () => {
    expect(bash('cp a.txt')).toEqual({ action: 'filesystem.write', target: 'cp', confidence: 'unknown' })
    expect(bash('mv')).toMatchObject({ action: 'filesystem.write', confidence: 'unknown' })
  })

  it('maps Copy-Item, Move-Item, Set-Content, Add-Content and Out-File to filesystem.write', () => {
    expect(ps(`Copy-Item a.txt "${elsewhere('x')}"`)).toEqual({
      action: 'filesystem.write', target: 'outside project: x', insideProject: false, confidence: 'high'
    })
    expect(ps(`Move-Item -Path a.txt -Destination "${elsewhere()}"`)).toMatchObject({
      action: 'filesystem.write', insideProject: false
    })
    expect(ps(`Set-Content -Path "${elsewhere('x.txt')}" -Value y`)).toMatchObject({
      action: 'filesystem.write', target: 'outside project: x.txt', insideProject: false
    })
    expect(ps('Set-Content x.txt y')).toMatchObject({ target: 'x.txt', insideProject: true })
    expect(ps('Add-Content -LiteralPath:log.txt -Value z')).toMatchObject({ target: 'log.txt', insideProject: true })
    expect(ps(`Out-File -FilePath "${elsewhere('x.txt')}" -Append`)).toMatchObject({
      action: 'filesystem.write', insideProject: false
    })
    expect(ps('Set-Content -Value y')).toMatchObject({ action: 'filesystem.write', confidence: 'unknown' })
  })

  it('sees a pipe into Out-File or tee as a write of its own', () => {
    expect(ps(`Get-Date | Out-File "${elsewhere('x.txt')}"`).commands).toEqual([
      { action: 'process.execute' },
      { action: 'filesystem.write', insideProject: false }
    ])
    expect(bash('echo x | tee ../o.txt').commands).toEqual([
      { action: 'process.execute' },
      { action: 'filesystem.write', insideProject: false }
    ])
    expect(bash('tee -a log.txt')).toMatchObject({ action: 'filesystem.write', target: 'log.txt', insideProject: true })
    expect(bash('tee')).toMatchObject({ action: 'process.execute', target: 'tee' })
  })

  it('sees the write a quoted PowerShell value is piped into: the value is data', () => {
    const r = ps(`"y" | Out-File "${elsewhere('x.txt')}"`)
    expect(r).toMatchObject({ action: 'filesystem.write', target: 'outside project: x.txt', insideProject: false, confidence: 'heuristic' })
  })

  it('maps sed -i to a write of its files', () => {
    expect(bash("sed -i 's/a/b/' ../x.txt")).toEqual({
      action: 'filesystem.write', target: 'outside project: x.txt', insideProject: false, confidence: 'high'
    })
    expect(bash("sed -i.bak -e 's/a/b/' x.txt")).toMatchObject({ action: 'filesystem.write', target: 'x.txt', insideProject: true })
    expect(bash("sed -i 's/a/b/'")).toMatchObject({ action: 'filesystem.write', confidence: 'unknown' })
  })

  it('maps find -delete and find -exec rm to filesystem.delete over where find starts', () => {
    expect(bash('find .. -name "*.log" -delete')).toEqual({
      action: 'filesystem.delete', target: 'find', insideProject: false, confidence: 'high'
    })
    expect(bash('find . -name x -exec rm {} \\;')).toMatchObject({ action: 'filesystem.delete', insideProject: true })
    expect(bash('find build -type f -delete')).toMatchObject({ insideProject: true })
    expect(bash('find $DIR -delete')).toMatchObject({ insideProject: false })
    expect(bash('find . -name x')).toMatchObject({ action: 'process.execute', target: 'find' })
  })

  it('is unknown which files xargs rm removes unless the line says', () => {
    const r = bash('ls ../elsewhere | xargs rm -rf')
    expect(r.confidence).toBe('unknown')
    expect(r.commands).toContainEqual({ action: 'filesystem.delete' })
    expect(bash('xargs -I{} rm {}')).toMatchObject({ action: 'filesystem.delete', confidence: 'unknown' })
    expect(bash('xargs rm -rf build')).toMatchObject({ action: 'filesystem.delete', insideProject: true, confidence: 'high' })
    expect(bash('xargs -n1 echo')).toMatchObject({ action: 'process.execute', confidence: 'high' })
  })

  it('reads the -Name:value form of a PowerShell parameter', () => {
    expect(ps(`Remove-Item -LiteralPath:"${elsewhere('x')}"`)).toMatchObject({ action: 'filesystem.delete', insideProject: false })
  })
})

describe('tools that run nothing, and the ones that look like it', () => {
  it.each(['TodoWrite', 'ToolSearch', 'Skill', 'SendMessage', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'TaskStop'])(
    'Claude %s is other and exact',
    (tool) => {
      expect(claude(tool, { anything: 1 })).toEqual({ action: 'other', target: tool, confidence: 'exact' })
    }
  )

  it.each(['wait', 'update_plan', 'sleep', 'send_message', 'list_agents'])('Codex %s is other and exact', (tool) => {
    expect(codex(tool, '{}')).toEqual({ action: 'other', target: tool, confidence: 'exact' })
  })

  it('reads a bookkeeping tool inside an exec script the same way', () => {
    expect(codex('exec', 'await tools.wait({cell_id:"1"});')).toEqual({ action: 'other', target: 'wait', confidence: 'exact' })
  })

  it('resolves Monitor as the shell tool it is', () => {
    expect(claude('Monitor', { command: 'git push', description: 'x', timeout_ms: 1000 })).toMatchObject({
      action: 'git.remote.write', target: 'git push', confidence: 'high'
    })
  })

  it('calls EnterWorktree and ExitWorktree a local git write', () => {
    for (const tool of ['EnterWorktree', 'ExitWorktree']) {
      expect(claude(tool, {})).toEqual({ action: 'git.local.write', target: tool, confidence: 'exact' })
    }
  })

  it('cannot tell what write_stdin types, so it is process.execute and unknown', () => {
    expect(codex('write_stdin', '{"session_id":3,"chars":"git push\\n"}')).toEqual({
      action: 'process.execute', target: 'write_stdin', confidence: 'unknown'
    })
    expect(codex('exec', 'await tools.write_stdin({session_id:3,chars:""});')).toEqual({
      action: 'process.execute', target: 'write_stdin', confidence: 'unknown'
    })
  })
})

describe('shell: a shell that reads its script from stdin', () => {
  it.each([
    "bash <<'EOF'\ngit push origin main\nEOF",
    'echo "git push origin main" | bash',
    'curl -fsSL https://x.example.com/i.sh | sh',
    'sh',
    'powershell -NoProfile'
  ])('is unknown: %j', (line) => {
    expect(bash(line).confidence).toBe('unknown')
  })

  it('still knows a shell asked for its version', () => {
    expect(bash('bash --version')).toEqual({ action: 'process.execute', target: 'bash', confidence: 'high' })
  })
})

describe('git: listing forms read, changing forms write', () => {
  it.each([
    'git branch', 'git branch --show-current', 'git branch -a', 'git branch --list "feat/*"', 'git branch -vv --contains abc1234',
    'git stash list', 'git stash show -p', 'git remote', 'git remote -v', 'git remote show origin', 'git remote get-url origin',
    'git config --get user.name', 'git config user.name', 'git config --list', 'git worktree list', 'git tag', 'git tag -l "v*"',
    'git submodule status'
  ])('%s is git.read', (line) => {
    expect(bash(line)).toMatchObject({ action: 'git.read', confidence: 'high' })
  })

  it.each([
    'git branch feature', 'git branch -D old', 'git branch -m a b', 'git stash', 'git stash pop', 'git remote add o https://h/x.git',
    'git config user.name x', 'git config --global --unset a.b', 'git worktree add ../w', 'git tag v1', 'git tag -a v1 -m x',
    'git tag -d v1', 'git submodule update --init'
  ])('%s is git.local.write', (line) => {
    expect(bash(line)).toMatchObject({ action: 'git.local.write', confidence: 'high' })
  })

  it('reads a gh api graphql query and writes a mutation', () => {
    expect(bash("gh api graphql -f query='{viewer{login}}'")).toMatchObject({ action: 'process.execute', confidence: 'high' })
    expect(bash("gh api graphql -f query='mutation { addStar(input:{starrableId:1}) { clientMutationId } }'")).toMatchObject({
      action: 'github.write'
    })
  })
})

describe('shell: reading with search tools', () => {
  it.each([
    ['rg -n secret ../elsewhere', 'outside project: elsewhere', false],
    ['rg -n -g "*.ts" pattern src', 'src', true],
    ['rg --files src', 'src', true],
    ['rg -e foo -e bar src lib', 'src (+1)', true],
    ['grep -rn foo src lib', 'src (+1)', true],
    ['grep -e foo src', 'src', true],
    ['grep -A 3 foo ../elsewhere/x.ts', 'outside project: x.ts', false],
    ["sed -n '1,50p' ../elsewhere/x.ts", 'outside project: x.ts', false],
    ['sed -e p src/a.ts', 'src/a.ts', true],
    ['nl -ba src/a.ts', 'src/a.ts', true]
  ])('%s reads %s', (line, target, insideProject) => {
    expect(bash(line)).toEqual({ action: 'filesystem.read', target, insideProject, confidence: 'high' })
  })

  it('is a plain command when no path is given', () => {
    for (const line of ['rg pattern', 'grep foo', 'rg -n -g "*.ts" pattern', "sed -n '1,5p'"]) {
      expect(bash(line)).toMatchObject({ action: 'process.execute', confidence: 'high' })
    }
  })

  it('keeps a long path to the length a Read keeps, not the shell cap', () => {
    const rel = `src/${'dir/'.repeat(20)}file.ts`
    expect(bash(`cat ${rel}`).target).toBe(rel)
    expect(claude('Read', { file_path: inProj(rel) }).target).toBe(rel)
  })
})

describe('PowerShell: condition groups and assignments are not commands', () => {
  it('reads the commands in the body of if, foreach and while, not the condition', () => {
    expect(ps('if ($LASTEXITCODE -ne 0) { exit 1 }')).toEqual({
      action: 'process.execute', target: 'exit', confidence: 'heuristic', commands: [{ action: 'process.execute' }]
    })
    const r = ps('foreach ($f in Get-ChildItem) { Remove-Item $f }')
    expect(r.confidence).toBe('heuristic')
    expect(acts(r)).toEqual(['filesystem.delete'])
    expect(acts(ps('if (Test-Path x) { Remove-Item x }'))).toEqual(['process.execute', 'filesystem.delete'])
    expect(acts(ps('if (-not (Test-Path x)) { New-Item x }'))).toEqual(['process.execute', 'filesystem.write'])
  })

  it('reads the command an assignment holds, and drops expression fragments', () => {
    expect(ps('$n = (Get-ChildItem).Count')).toMatchObject({ action: 'filesystem.read', confidence: 'heuristic' })
    expect(ps('$x = Get-Content a.txt')).toMatchObject({ action: 'filesystem.read', target: 'a.txt', confidence: 'high' })
  })

  it('does not let a shell word starting with $ pass for an expression in Bash', () => {
    expect(bash('$CC main.c').confidence).toBe('unknown')
  })
})

// Fix round 2 (re-review).
describe('a quoted word in command position is data, whatever came before it', () => {
  it.each([
    ["$pw = 'P@ssw0rd1'", 'P@ssw0rd1'],
    ['$token = "abc123def456"', 'abc123def456'],
    ["$env:API_KEY = 'abc123xyz'", 'abc123xyz'],
    ["('hunter2') | Out-Null", 'hunter2'],
    ["@('hunter2','x') | ForEach-Object { $_ }", 'hunter2'],
    ["$h = @{ pass = 'hunter2' }", 'hunter2'],
    ["'C:\\pw\\hunter2' | docker login --password-stdin", 'hunter2'],
    ["$pw = 'hunter2'; docker login -p $pw", 'hunter2']
  ])('PowerShell %s leaves %s out of the record', (line, secret) => {
    expect(JSON.stringify(ps(line))).not.toContain(secret)
  })

  it('lets the next real command headline once PowerShell data is dropped', () => {
    expect(ps("'C:\\pw\\hunter2' | docker login --password-stdin")).toMatchObject({ target: 'docker login' })
    expect(ps("$pw = 'hunter2'; docker login -p $pw")).toMatchObject({ target: 'docker login' })
    expect(ps("('hunter2') | Out-Null")).toMatchObject({ target: 'Out-Null' })
    expect(ps("$pw = 'hunter2'")).toEqual({ action: 'process.execute', target: 'shell', confidence: 'unknown' })
  })

  it.each([
    ["sudo 'hunter2'", 'hunter2'],
    ["if true; then 'hunter2'; fi", 'hunter2'],
    ["env FOO=1 'hunter2'", 'hunter2'],
    ["timeout 5 'hunter2'", 'hunter2'],
    ["git 'hunter2'", 'hunter2'],
    ["npx 'hunter2'", 'hunter2']
  ])('Bash %s leaves %s out of the record', (line, secret) => {
    expect(JSON.stringify(bash(line))).not.toContain(secret)
  })

  it('shows a quoted word that follows a stripped prefix as an unknown program, and keeps the subcommand out', () => {
    expect(bash("sudo 'hunter2'")).toMatchObject({ target: 'shell', confidence: 'unknown' })
    expect(bash("git 'hunter2'").target).toBe('git')
    expect(bash("npx 'hunter2'").target).toBe('npx')
  })

  it('shows a quoted word after the call operator as a program only when it is a path or a known program', () => {
    expect(ps("& 'hunter2'")).toMatchObject({ target: 'shell', confidence: 'unknown' })
    expect(ps("& 'git' push")).toMatchObject({ action: 'git.remote.write', confidence: 'high' })
    expect(ps("& 'C:\\tools\\mytool.exe' --x")).toMatchObject({ target: 'mytool', confidence: 'unknown' })
  })
})

describe('a line with more than one entry in commands is at most heuristic', () => {
  it.each([
    'npm test > ../out.log',
    'npm test > out.log',
    'git diff > ../p.diff',
    'cat a.txt > ../b.txt',
    'ls > x.txt',
    'curl https://a.example.com/x > ../x',
    'echo x > out.txt'
  ])('%s', (line) => {
    const r = bash(line)
    expect(r.commands?.length).toBeGreaterThan(1)
    expect(r.confidence).toBe('heuristic')
  })

  it('holds inside an exec script too', () => {
    expect(codex('exec', 'await tools.exec_command({cmd:"cat a > ../b"});').confidence).toBe('heuristic')
  })

  it('leaves a single command, and a redirection alone, as sure as they were', () => {
    expect(bash('git diff').confidence).toBe('high')
    expect(bash('> out.txt').confidence).toBe('high')
  })
})

describe('PowerShell writers take the named path over a positional word, and never a value', () => {
  it('reads -Path, -LiteralPath and -FilePath before positional words', () => {
    expect(ps(`Set-Content 'v' -Path "${elsewhere('x.txt')}"`)).toEqual({
      action: 'filesystem.write', target: 'outside project: x.txt', insideProject: false, confidence: 'high'
    })
    expect(ps(`Add-Content 'v' -LiteralPath "${elsewhere('y.txt')}"`)).toMatchObject({ target: 'outside project: y.txt' })
  })

  it('skips -InputObject and -Value, so a value is never the target or the place', () => {
    const r = ps("Out-File -InputObject 'hunter2' -FilePath x.txt")
    expect(r).toMatchObject({ action: 'filesystem.write', target: 'x.txt', insideProject: true })
    expect(JSON.stringify(r)).not.toContain('hunter2')
    const none = ps("Set-Content -InputObject 'hunter2'")
    expect(none).toMatchObject({ action: 'filesystem.write', confidence: 'unknown' })
    expect(JSON.stringify(none)).not.toContain('hunter2')
  })
})

describe('PowerShell: a call that does something is a command, not an expression', () => {
  it.each([
    ["[IO.File]::WriteAllText($p, 'y')", 'filesystem.write'],
    ['[System.IO.File]::AppendAllText($p, $c)', 'filesystem.write'],
    ['[IO.File]::Copy($a, $b)', 'filesystem.write'],
    ['[IO.File]::Move($a, $b)', 'filesystem.write'],
    ['[IO.Directory]::Delete($d, $true)', 'filesystem.delete'],
    ['$f.Delete()', 'filesystem.delete'],
    ['(Get-Item $p).Delete()', 'filesystem.delete'],
    ['[IO.File]::ReadAllText($p)', 'filesystem.read'],
    ['[IO.Directory]::GetFiles($d)', 'filesystem.read']
  ] satisfies Array<[string, AuditAction]>)('%s is %s, heuristic, with no place', (line, action) => {
    const r = ps(line)
    expect(r.confidence).toBe('heuristic')
    expect(r.commands?.map((c) => c.action) ?? [r.action]).toContain(action)
    expect(r.commands?.every((c) => c.insideProject === undefined) ?? true).toBe(true)
    expect(r).not.toHaveProperty('insideProject')
  })

  it('headlines a lone write or delete call by its method name', () => {
    expect(ps("[IO.File]::WriteAllText($p, 'y')")).toMatchObject({ action: 'filesystem.write', target: 'WriteAllText' })
    expect(ps('$f.Delete()')).toEqual({ action: 'filesystem.delete', target: 'Delete', confidence: 'heuristic' })
  })

  it('is unknown for a call it cannot read as a read, a write or a delete', () => {
    for (const line of ['$p.Kill()', '[Diagnostics.Process]::Start($x)', '(New-Object Net.WebClient).DownloadFile($u, $o)', '[Clipboard]::SetText($t)']) {
      expect(ps(line).confidence).toBe('unknown')
    }
  })

  it('keeps the arithmetic, string and conversion calls of a script as expressions', () => {
    for (const line of [
      '$n = [math]::Min(1, 2); Get-Date',
      "$s = $name.ToLower().Trim(); Get-Date",
      "$m = [regex]::Match($a, 'x'); Get-Date",
      "$e = [Environment]::GetEnvironmentVariable('X'); Get-Date",
      '$i++; Get-Date',
      '$n = $list.Count; Get-Date',
      '$x = [int]$y; Get-Date',
      '$ok = -not $z; Get-Date'
    ]) {
      expect(ps(line)).toMatchObject({ action: 'process.execute', target: 'Get-Date', confidence: 'heuristic' })
    }
  })

  it('does not read the items of a call\'s argument list as commands', () => {
    const r = ps('[IO.File]::Copy(a.txt, b.txt)')
    expect(r).toMatchObject({ action: 'filesystem.write', confidence: 'heuristic' })
  })

  it('sees a delete inside a loop body', () => {
    expect(acts(ps('foreach ($f in $files) { $f.Delete() }'))).toEqual(['filesystem.delete'])
  })
})

describe('shell: more writers, each with the place of its destination', () => {
  it.each([
    ['touch ../x', 'outside project: x', false],
    ['touch a b', 'a (+1)', true],
    ['mkdir -p ../x', 'outside project: x', false],
    ['mkdir -m 755 out', 'out', true],
    ['ln -s a ../b', 'outside project: b', false],
    ['unzip a.zip -d ../x', 'outside project: x', false],
    ['unzip a.zip', '.', true],
    ['tar -xzf a.tgz -C ../x', 'outside project: x', false],
    ['tar xzf a.tgz', '.', true],
    ['tar -C ../x -xf a.tar', 'outside project: x', false],
    ['tar -czf ../a.tgz src', 'outside project: a.tgz', false],
    ['tar -cf out.tar src', 'out.tar', true],
    ['rsync -a src/ ../backup/', 'outside project: backup', false],
    ['rsync -a -e ssh src/ me@host.example.com:/backup/', 'outside project: backup', false],
    ['rsync -a --exclude node_modules src/ out/', 'out', true]
  ])('%s writes %s', (line, target, insideProject) => {
    expect(bash(line)).toEqual({ action: 'filesystem.write', target, insideProject, confidence: 'high' })
  })

  it('is unknown when the destination cannot be determined', () => {
    for (const line of ['touch', 'mkdir', 'rsync -a src/', 'tar -cf', 'ln -s a']) {
      expect(bash(line)).toMatchObject({ action: 'filesystem.write', confidence: 'unknown' })
    }
  })

  it('does not take listing or testing for a write', () => {
    expect(bash('tar -tf a.tgz')).toMatchObject({ action: 'process.execute', confidence: 'high' })
    expect(bash('unzip -l a.zip')).toMatchObject({ action: 'process.execute', confidence: 'high' })
  })

  it('maps robocopy and xcopy to a write of their destination, past the switches', () => {
    expect(bash(`robocopy src "${elsewhere('dst')}" /E`)).toEqual({
      action: 'filesystem.write', target: 'outside project: dst', insideProject: false, confidence: 'high'
    })
    expect(bash('robocopy src dst /MIR /XD node_modules')).toMatchObject({ target: 'dst', insideProject: true })
    expect(bash('xcopy src dst /E /I')).toMatchObject({ action: 'filesystem.write', target: 'dst', insideProject: true })
  })

  it('maps New-Item and Rename-Item to a write of the item', () => {
    expect(ps(`New-Item -Path "${elsewhere('x.txt')}" -ItemType File -Value y`)).toEqual({
      action: 'filesystem.write', target: 'outside project: x.txt', insideProject: false, confidence: 'high'
    })
    expect(ps('New-Item -ItemType File x.txt')).toMatchObject({ target: 'x.txt', insideProject: true })
    expect(ps(`Rename-Item "${elsewhere('x')}" y`)).toMatchObject({ target: 'outside project: x', insideProject: false })
    expect(ps(`Rename-Item -Path "${elsewhere('x')}" -NewName y`)).toMatchObject({ target: 'outside project: x' })
  })

  it('sees the file curl and wget save, next to the request', () => {
    expect(bash('curl -o ../x https://a.example.com/x')).toEqual({
      action: 'network.request',
      target: 'a.example.com',
      confidence: 'heuristic',
      commands: [{ action: 'network.request' }, { action: 'filesystem.write', insideProject: false }]
    })
    expect(bash('curl --output=out/x https://a.example.com/x').commands).toEqual([
      { action: 'network.request' },
      { action: 'filesystem.write', insideProject: true }
    ])
    expect(bash('wget -O ../x https://a.example.com/x').commands).toContainEqual({ action: 'filesystem.write', insideProject: false })
    expect(bash('wget -P ../dir https://a.example.com/x').commands).toContainEqual({ action: 'filesystem.write', insideProject: false })
    expect(bash('curl -o - https://a.example.com/x')).toEqual({ action: 'network.request', target: 'a.example.com', confidence: 'high' })
    expect(bash('wget -O - https://a.example.com/x').commands).toBeUndefined()
  })
})

describe('what a target shows of a long path, a URL, a Glob and an rg flag', () => {
  const ghp = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'

  it('redacts a path before it is cut, so the front of a token at the cap is not shown', () => {
    const rel = `${'dir/'.repeat(46)}${ghp}`
    for (const r of [bash(`cat ${rel}`), bash(`echo x > ${rel}`), claude('Read', { file_path: inProj(rel) })]) {
      expect(r.target).not.toContain('ghp_')
      expect(r.target.length).toBeLessThanOrEqual(200)
    }
  })

  it('does not let a URL used as a path expose its credentials', () => {
    const r = bash('cp a https://me:hunter2@host.example.com/x')
    expect(r).toEqual({ action: 'filesystem.write', target: 'outside project: host.example.com', insideProject: false, confidence: 'high' })
    expect(JSON.stringify(claude('Read', { file_path: 'https://me:hunter2@host.example.com/x' }))).not.toContain('hunter2')
    expect(claude('Read', { file_path: 'https://me:hunter2@host.example.com/x' })).toMatchObject({ insideProject: false })
  })

  it('reads host:path as a remote place, outside the project', () => {
    expect(bash('rsync -a src/ build-host:/srv/app/')).toMatchObject({ target: 'outside project: app', insideProject: false })
  })

  it('reads a Glob pattern of the home folder as outside', () => {
    expect(claude('Glob', { pattern: '~/**/*.ts' })).toMatchObject({ action: 'filesystem.read', insideProject: false })
    expect(claude('Glob', { pattern: '~/notes/*.md' })).toMatchObject({ insideProject: false })
  })

  it.each([
    ['rg --color never hunter2 src', 'src'],
    ['rg --colors match:fg:red hunter2 src lib', 'src (+1)'],
    ['rg --engine pcre2 hunter2 src', 'src'],
    ['rg --context-separator -- hunter2 src', 'src']
  ])('%s reads %s and not the value of the flag', (line, target) => {
    expect(bash(line)).toMatchObject({ action: 'filesystem.read', target })
  })
})

// The Host feeds this from files and streams it does not control.
describe('malformed and hostile input', () => {
  it('never throws, and says other and unknown when it cannot read the call', () => {
    const bad = [undefined, null, 42, [], {}, 'x']
    for (const input of bad) {
      for (const tool of ['Bash', 'Read', 'Write', 'WebFetch', 'mcp__a__b', 'Agent']) {
        expect(() => claude(tool, input)).not.toThrow()
      }
      expect(() => codex('exec', input)).not.toThrow()
      expect(() => codex('apply_patch', input)).not.toThrow()
    }
    expect(resolveAction({ provider: 'claude', tool: undefined as never, input: {}, cwd })).toEqual({
      action: 'other', target: 'unknown', confidence: 'unknown'
    })
    expect(() => resolveAction({ provider: 'claude', tool: 'Read', input: { file_path: 'a' }, cwd: undefined as never })).not.toThrow()
    expect(claude('Bash', { command: ['a', 1, null, { x: 1 }] })).toMatchObject({ confidence: 'unknown' })
  })

  it('stays fast on a huge word, many heredocs and unbalanced quotes', () => {
    const started = Date.now()
    const huge = bash('a1B2'.repeat(250_000))
    expect(huge.target.length).toBeLessThanOrEqual(60)
    bash("cat <<A\n".repeat(20_000))
    bash(`echo "${'x'.repeat(500_000)}`)
    bash(`${'token'.repeat(100_000)}`)
    expect(redactTarget('a'.repeat(1_000_000)).length).toBeLessThanOrEqual(1000)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reads an apply_patch header with a long run of spaces in linear time', () => {
    const patch = `*** Begin Patch\n*** Add File: a${' '.repeat(40_000)}b\n*** End Patch`
    const started = Date.now()
    codex('apply_patch', patch)
    codex('exec', `await tools.apply_patch(${JSON.stringify(patch)})`)
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('reads apply_patch headers that end in spaces or CRLF', () => {
    const r = codex('apply_patch', '*** Begin Patch\r\n*** Update File: src/a.ts   \r\n*** End Patch\r\n')
    expect(r).toMatchObject({ target: 'src/a.ts', insideProject: true })
  })

  it('redacts shell targets in time that does not grow with the length of the line', () => {
    const started = Date.now()
    bash(Array(50).fill('key.'.repeat(250)).join(';'))
    bash(Array(50).fill(`cat a${'-key'.repeat(250)}`).join(';'))
    bash(Array(2000).fill('key.'.repeat(50)).join(';'))
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('cuts shell text before redacting, so a secret late in a long word is not what is stored', () => {
    const r = bash(`${'a'.repeat(300)}hunter2hunter2`)
    expect(r.target.length).toBeLessThanOrEqual(60)
    expect(JSON.stringify(r)).not.toContain('hunter2')
  })
})

describe('redactTarget', () => {
  it.each([
    ['Bearer abc123.def456-ghi', 'abc123'],
    ['Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
    ['api_key=hunter2hunter2', 'hunter2'],
    ['--token s3cr3tvalue', 's3cr3t'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-ant'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'github_pat_11'],
    ['xoxb-1234567890-abcdefghij', 'xoxb-'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIA'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'eyJ'],
    ['3f786850e387550fdab836ed7e6dc881de23001b', '3f786850'],
    ['QWxhZGRpbjpPcGVuU2VzYW1lMTIzNDU2Nzg5MGFiY2Q=', 'QWxhZGRpbjpP'],
    ['https://user:hunter2@host.example.com/x', 'hunter2']
  ])('masks %s', (input, leak) => {
    const out = redactTarget(input)
    expect(out).not.toContain(leak)
    expect(out).toContain('[redacted]')
  })

  it.each([
    'git push',
    'npm test',
    'src/components/Button.tsx',
    'outside project: notes.md',
    '2026-10-23-observe-mode-design-doc.md',
    'docs/2026-10-23-ObserveModeDesignDocument.md',
    'src/ObserveModeDesignDocumentFinalReviewedVersion2/index.ts',
    'github.create_issue',
    'api.example.com',
    'web search'
  ])('leaves %s alone', (input) => {
    expect(redactTarget(input)).toBe(input)
  })

  it('still masks a random token inside a path, and one that stands alone', () => {
    expect(redactTarget('src/Zq9Xk2LmVb7NcR4tYp1WsE8dFg5HjA3u6IoP0/a.ts')).not.toContain('Zq9Xk2')
    expect(redactTarget('npx Zq9Xk2LmVb7NcR4tYp1WsE8dFg5HjA3u6IoP0')).not.toContain('Zq9Xk2')
  })

  it('keeps a readable file name read through the shell whole', () => {
    expect(bash('cat docs/2026-10-23-ObserveModeDesignDocument.md').target).toBe('docs/2026-10-23-ObserveModeDesignDocument.md')
  })

  it('is idempotent', () => {
    const once = redactTarget('curl -H "Authorization: Bearer abc123def456"')
    expect(redactTarget(once)).toBe(once)
  })
})

describe('no secret reaches a target (review focus 2)', () => {
  const secrets = [
    'abc123def456ghi789',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    'hunter2hunter2'
  ]
  const lines = [
    `curl -s -H "Authorization: Bearer ${secrets[0]}" https://api.example.com/v1`,
    `curl -u admin:${secrets[3]} https://api.example.com/v1`,
    `curl https://user:${secrets[3]}@host.example.com/path?token=${secrets[0]}`,
    `TOKEN=${secrets[0]} npm publish`,
    `GITHUB_TOKEN=${secrets[1]} gh pr create --body "x"`,
    `git push https://user:${secrets[1]}@github.com/o/r.git main`,
    `npm config set //registry.npmjs.org/:_authToken=${secrets[0]}`,
    `export API_KEY=${secrets[2]} && npm test`,
    `docker login -u me -p ${secrets[3]}`,
    `${secrets[2]}`,
    `./${secrets[2]}.sh`,
    `Invoke-WebRequest -Uri https://a.example.com -Headers @{Authorization="Bearer ${secrets[0]}"}`
  ]

  it.each(lines)('%s', (line) => {
    const text = JSON.stringify(bash(line))
    for (const s of secrets) expect(text).not.toContain(s)
    expect(JSON.stringify(claude('PowerShell', { command: line }))).not.toContain(secrets[0])
    expect(JSON.stringify(codex('exec_command', { cmd: line }))).not.toContain(secrets[1])
  })

  it('redacts before it clips, so the front of a cut token cannot slip through', () => {
    const token = 'Zq9Xk2LmVb7NcR4tYp1WsE8dFg5HjA3u6IoP0'
    const r = bash(`${'a'.repeat(50)}.${token}`)
    expect(r.target).not.toContain(token.slice(0, 6))
  })

  it('keeps a target at the shell length cap', () => {
    expect(bash(`${'a'.repeat(200)}`).target.length).toBeLessThanOrEqual(60)
  })
})
