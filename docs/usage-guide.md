# Everyday usage guide

Start with one session, then add the features that fit your work. Astera runs your installed
Claude Code and Codex tools using your own accounts.

## Start a session

1. [Install Astera and your chosen CLI](../README.md#install).
2. In **Accounts**, use **Auto-detect** to register an existing account, or **Add account** to
   create a separate account entry and complete its sign-in.
3. Open **New session**, choose your **Project folder** and **Account**, then choose
   **Terminal** or **Chat** and click **Start**.
4. Describe the result you want and how to check it. Answer questions and approvals as they arrive.

Terminal gives you the CLI interface. Chat gives you a message composer, question and approval
cards, and model and permission controls. Drop a file or paste an image into Chat to include its
path in your message. A session keeps the type it was created with; choose the default for new
sessions under **Settings → General → New sessions start as**.

## Reopen an earlier conversation

1. Open **Accounts and history** and expand the project in History.
2. Click a conversation to preview it. Previewing does not start a session.
3. Use its **Resume session** button, choose a logged-in account, and click **Resume**.

If the project folder moved, select its current location when prompted. To bring back a project
hidden from the history list, use **Settings → History → Unhide**.

## Use multiple accounts

Register the accounts you need and sign in to each. In **New session**, pick the first account
and use **+ Add account** to set the rolling order. When a usage limit is reached, Astera can
continue on the next available account for the same service. Each account retains its own limits.

With a single account, **Wait for the limit to reset, then resume automatically** controls waiting
and resuming. With multiple accounts, rolling is automatic; check the displayed reset time if
there is no available account to switch to.

When adding an account, **Import settings from the default account** can bring over its setup.
Review the import dialog: both providers merge item by item, Codex keeps the account's own trusted
folders and hook approvals, and imported settings apply to new sessions rather than sessions
already running.

To give every account the same MCP servers, skills, slash commands and subagents, use
**Settings → MCP & Skills**. Choose **Add**, pick an account and what to share, and
choose which environment values to keep as secrets. A server that carries a credential in its
arguments or its address is not offered, since it would be stored in plain text. The sessions
Astera starts then get the shared MCP servers. A server that runs as a command runs once inside
Astera's MCP Gateway for each project folder: sessions in that folder share it, reach it with a
token of their own, and never see its secret values. Sessions sharing a process also share what
it is told to log and which of its resources are watched. Turn on **Run per session** for a
server that holds a browser or a connection, or when that sharing matters. A remote server is reached directly by each session,
so an account's own sign-in to it keeps working. Each server says per account whether its
sessions get it and why not (an account with its own server of that name keeps its own, for
example), and whether its process is running. Each account also
gets a copy of the shared skills, commands and subagents. Each item shows how its copy stands in
every account: a copy edited outside Astera is put back and the edit kept in backups,
and an account that already has its own different copy keeps it until you choose **Use the
shared version**. Once anything is shared, **Import settings from the default account** leaves
these to MCP & Skills and copies settings only. `astera ext list` and `astera ext sync` do the same
from a terminal (see [the CLI reference](cli.md)).

**Claude Code plugins** are shared from the same tab, and its **Plugins** group lists them. Choose
**Add**, pick a Claude account, and that account's plugins are listed with its servers and skills.
Pick the ones to share.
Astera installs one copy of each in its own folder, and every Claude session Astera starts loads
that copy, so every account runs the same version. In those sessions a shared plugin replaces an
account's own copy of the same name while it is shared and on. Turn it off or remove it, and the
account's own copy runs again from its next session. Opening a row lists the accounts that have
their own copy, with its version. Nothing in a Claude account's folder is changed, and a `claude` you
start outside Astera does not get the shared plugins. A plugin that needs settings values, comes from a
marketplace address that holds a password or key, or was not installed from a marketplace is shown
with the reason it cannot be shared, and two shared plugins cannot have the same name.

Every shared plugin is also installed into every Codex account, so a `codex` you start outside Astera
has it too, unlike a Claude session. Astera puts it into each account's own folder in Codex's form: agents
are left out, commands become skills named `<plugin>:source-command-<name>`, and Astera trusts the
plugin's hooks in each Codex account, so no hook review menu stops a session. A Codex account's own
plugin of the same name is turned off while the shared one is on, and turned back on after the shared
one is turned off or removed, if Astera turned it off and it is still there. An account with a running
Astera Codex session does not get a new plugin or a new version, or lose a removed plugin, until its
sessions end; turning a plugin on or off reaches an account that already has it at once. Opening the
plugin's row lists each Codex account's state: the installed version, waiting for its sessions to end,
the previous version kept because the new one could not be converted for Codex, or the reason it failed.
While every Codex account has the shared version, a single line says so. What Codex does differently
with the plugin waits folded under **What is different in Codex**.

Astera looks for newer versions when it starts and once a day, and **Check now** does it at once.
A newer version only marks the row **Update available**. A shared plugin never changes until you
press **Update**. If a marketplace asks to run a command of its own to install or update a plugin,
Astera shows you the command and runs it only after you confirm. Once any plugin is shared,
**Import settings from the default account** keeps a Claude account's own `enabledPlugins` and
`extraKnownMarketplaces`, and a Codex account's own `plugins` and `marketplaces` tables in `config.toml`,
instead of copying the default account's, and copies the other settings as before. Astera then brings
that Codex account in line with the shared plugins. Sharing only plugins does not stop the import from
copying the default account's servers, skills, commands and agents. `astera ext list` names the shared
plugins and each Codex account's state.

**Smart Resume** is optional and experimental. Choose it under **Settings → Agents → Session
resume strategy** to give a new session a compact checkpoint when rolling moves work to another
account. If checkpoint creation fails, Astera falls back to ordinary resume.

## Schedule work and receive updates

In **New session**, enable **Scheduler**, choose an interval or a daily, weekly, or monthly rule,
then enter the command for Terminal or the prompt for Chat. Start the session to activate it.
Keep Astera running and the computer awake when you expect scheduled work to run.

For Slack updates, follow the [Slack bot setup](slack-bot-setup.md), then enable
**Slack progress notifications** for the session. Bot mode groups a session's updates in one
thread. Replies require Socket Mode and your configured Slack member ID; without that ID,
no member's replies reach the session.

For notifications on your computer, open **Settings → Notifications**. Choose alerts for
input needed, waiting on a limit, and account switches. Desktop alerts are sent when you are
looking at another session or window.

## Work with files and panes

Open **Explorer** to browse files and their git status. File tabs and session tabs share a pane;
split right or down to keep a file beside the session changing it. Use the project terminal for
commands you want to run yourself.

A Markdown file can be shown as an editor, split editor/preview, or preview alone. Press
**Ctrl/Cmd + Shift + V** to cycle these modes. The split views follow each other's scrolling.

For a deletion captured by Astera, right-click in the explorer and choose **Local History…**.
Select the deleted item and click **Restore**. If its old path is already occupied, the restored
copy gets another name; check the reported path. Snapshots are kept for up to 30 days within the
project's size budget. Items over 50 MB are excluded, so a missing snapshot cannot be recovered
through this feature.

## Run a dev server, build, or test

Choose a configuration in the Run toolbar and run it. Astera detects supported project scripts
and tasks, including npm scripts and standard Gradle/Maven tasks. A detected configuration appears
in italics until you edit it and save it as your own.

Choose the appropriate configuration kind when adding one: Shell, npm, Node.js, Gradle, Maven,
cargo, go, Python, pytest, Docker Compose, Dockerfile, .NET, or Compound. Use its fields for that
tool rather than manually assembling every command. Read the Run console for output and errors.

### Test results

Add **Test report** to a configuration that runs tests: the format (JUnit XML or Vitest JSON) and where the run writes
it, relative to the configuration's working folder. A file or, for JUnit XML, a folder of `*.xml` files works:

- Vitest: `--reporter=junit --outputFile=report.xml`, or `--reporter=json --outputFile=report.json` with Vitest JSON
- pytest: `--junitxml=report.xml`
- Gradle: `build/test-results/test`
- Maven: `target/surefire-reports`

After each run you start, the **Tests** tab of the bottom panel shows the result: counts, how long it took, and the
cases by file and suite, failing first. Open a case to read its failure, or **Open** to go to its line. Failed tests
also appear in the Problems tab, where you can send them to an agent or start a Job to fix them.

**Run again** reruns the configuration. **Run failures again** runs only what failed and updates the result: pytest by
the failing tests, and a configuration with a Vitest JSON report (Node.js, Shell, or an npm, pnpm or yarn script) by
the failing files and test names. When it cannot narrow that far, it runs the failing files (a file that failed outside
its tests, a test name a shell cannot pass safely, a pnpm script on Windows whose test names need escaping, or more
failures than one command line holds) or the whole configuration (any other configuration or report, a pytest
configuration that names a target, a Shell command that chains or pipes commands, a bun script, or more failing files
than one command line holds), and the message says why.

A report left by an earlier run, a run you stopped, and a report that cannot be read or was cut short are never shown as
passed: the tab says what happened instead, and such results do not reach the Problems tab. On a drive that keeps file
times in two second steps (FAT or exFAT, and some network shares), the report of a run that ends within a second or two
can read as an earlier run's. A Job's check that runs the
configuration lists its failures among the check's findings, so the repair sees exactly which tests failed. Turn the tab
off in Settings › General › **Tests tab**.

### Language server diagnostics

TypeScript, JavaScript and Python files you open in the editor are checked by a language server, and their problems
appear in the Problems tab with the line and column; a row opens its file there, and can be sent to an agent or made
into a new Job draft like any other.

Install the servers in Settings › **Language servers**. Each **Install** first shows the packages it fetches (name,
exact version, licence, size, and the folder they go to); Astera uses a package only after checking it is the exact one
it pinned. Nothing is fetched until you approve it.

| Server | Checks | Packages |
|---|---|---|
| TypeScript | TS and JS projects on TypeScript 6 or later, or with no TypeScript of their own | TypeScript 7.0.2's own language server (Apache-2.0, about 28 MB) |
| TypeScript 5 | projects whose own TypeScript is below 6 | typescript-language-server 6.1.0 with TypeScript 5.9.3 (Apache-2.0, about 26 MB) |
| Python | Python files | pyright 1.1.414 (MIT, about 19 MB) |

Which TypeScript a project uses is read from its `node_modules/typescript/package.json`, or else from the `typescript`
range in its `package.json`; nothing of the project runs. A project below TypeScript 6 is checked by TypeScript 7 when
only that server is installed, and the server's status says so. A setting path replaces an installed server (TypeScript
7's `tsc`, or pyright's `langserver.index.js`); a project's own `node_modules` is never used.

The servers run in this computer's Astera Host: one for each project and language with an open file, at most four at
once, each stopped a minute after its last file closes. When a project is not being checked (its server is not
installed, was stopped to make room for another, or stopped after crashing three times), the Problems tab says so in
one row; saving a file in a project stopped to make room starts its server again, and **Restart** in Settings ›
**Language servers** starts either again. A file over 2 MB is not checked, and the Problems tab says that too. A file is
checked as it is on disk: after you save it, or when an agent changes it; pyright also hears of Python files changed or
deleted on disk that are not open.

pyright is always given an absolute interpreter: a project's virtual environment once you choose **Use in this
project** for it, else the interpreter you set, else the first one found on this computer outside the project. With
none, problems about packages that are not installed are not shown, since they would not be real. Nothing inside the
project is run to find the interpreter. An interpreter you set must be an absolute path, and a `.bat` or `.cmd` one is
refused.

Not supported, by design: completion, rename, formatting, code actions, hover, go to definition, inlay hints, an
underline in the editor, and language servers on a remote runtime. Turn the feature off in Settings › General ›
**Language server diagnostics**.

## Isolate work and open a pull request

1. In a git project with a commit and branch, enable **Start in a separate worktree** in
   **New session**. Choose the base branch if needed.
2. Make and review changes in that worktree.
3. Use the worktree list to see PR state. When the branch has commits its base does not have,
   its create-PR action can push the branch and open a pull request.

Astera uses your existing GitHub CLI (`gh`) login. Review the target branch and PR details in the
dialog before creating it.

## Give visual feedback with Design Mode

1. Open your web page in an Astera tab and turn on **Design Mode**.
2. Click an element, write what should change, and choose **Change** or **Question**.
3. Choose **Send to session** and select the session that should receive your notes.

Notes include the element's details and a cropped screenshot. You can keep up to twenty notes in
a tab. Design Mode turns off when the page navigates away.

To let the agent inspect the local app itself, enable the experimental **Agent browser** setting
and start a new session. Ask it to check the project's dev server; it can inspect pages, click
through a flow, and read console and network errors. This browser is restricted to local pages.

## Coordinate tasks and understand the results

- **Jobs:** enable **Agent orchestration**, then use **Jobs → New job** for an objective with
  workers, dependencies, and completion checks. See the [Job lifecycle](jobs.md) for worktrees,
  repair attempts, manual merging, and the differences between normal and scheduled Jobs.
- **Agent review:** in a Run's changed files, pick a Task to see its whole range or one attempt's own (first try,
  retry or repair), with the commits it was read over named. Each file says who changed it from the ranges the Host
  recorded, never the git author or a file time: an agent (with the attempts and their evidence, confirmed by the
  observe audit when it saw the writes), mixed (another worker was in the same folder at the same time), or unknown
  (no recorded range holds it, the range was rebased, or uncommitted edits in the project folder). Commits a person
  made in the same folder are not told apart. Opening a file shows the Task's review findings under the line they
  were made on; once the Task moves to another revision they are listed above the file as found on another revision,
  and the Problems row says the revision changed, with the finding's state unchanged. Each shows its state and history,
  and **Fix with an agent** sends it as the Task's repair request, after asking. Settings › General ›
  **Agent review** turns it off. See the [Job lifecycle](jobs.md) for the details.
- **How It Works:** enable **Work unit tracking**, choose an **Explanation account**, and use
  `/astera-task` in a new session. See the [How It Works guide](how-it-works.md) for reading records,
  flow diagrams, decision sources, and verification results.

## Adjust appearance, language, and shortcuts

- **Settings → Appearance:** choose a theme and terminal font. Theme changes apply to open
  terminals without clearing their scrollback.
- **Settings → General → Language:** choose English, Korean, Japanese, Spanish, or System.
- **Settings → Shortcuts:** inspect and remap the controls. The defaults use Cmd on macOS and
  Ctrl on other systems.

| Action | Default shortcut |
| --- | --- |
| Explorer | Ctrl/Cmd + Shift + E |
| Jobs | Ctrl/Cmd + Shift + J |
| How It Works | Ctrl/Cmd + Shift + H |
| Markdown display mode | Ctrl/Cmd + Shift + V |

## Check for an update

Open **Settings → Info → Check for updates** and follow the available download/install action.
Review the restart prompt before installing. Update support depends on the platform and build;
when an automatic update is unavailable, use the matching installer from
[GitHub Releases](https://github.com/parsingk/Astera/releases/latest) and follow the
[platform installation notes](../README.md#install).
