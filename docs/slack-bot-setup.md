# Get session notifications in Slack, and reply to keep the work going

This guide sets things up so that Slack on your phone **receives your work progress** and lets you **reply in a thread to send a prompt into the session**.

Once it is set up, it looks like this.

```
#my-work-alerts channel
│
├─ 🖥 myproj · work1              ← this message appears when you start a session
│  D:\proj\myproj
│  │
│  ├─ ✅ Response complete          ← when a turn finishes
│  │  > Modified 3 files…
│  ├─ 🙋 Input needed — how should I proceed?   ← when it is waiting on an approval or a question
│  │  1. Fix it now — handle it on this branch
│  │  2. Separate ticket — split it out and do it later
│  ├─ ⏸ Limit reached — resuming at 15:20
│  │
│  └─ [reply here]  ────────────→ typed into that session's terminal
│
└─ 🖥 other-proj · work2          ← every session gets its own thread
```

**One session = one thread.** Which thread you reply to decides which session the text goes to.

**While it waits on a question or an approval, you see exactly what is being asked.** Questions with choices, like AskUserQuestion, arrive in `1. … / 2. …` form, and a pending tool approval arrives together with which tool wants to run and with what — because a one-line label is not enough to decide on a phone. The tools involved are the command-running and file-writing ones (Bash, PowerShell, Write, Edit), so if you have also made file reads require approval, those notifications arrive as a single line of text only.
How to reply is in [How to reply to a multiple-choice prompt](#how-to-reply-to-a-multiple-choice-prompt) below, and what to be careful about on an approval is in [What to watch out for when replying to an approval prompt](#what-to-watch-out-for-when-replying-to-an-approval-prompt).

All you need is a Slack account, and it takes about 15 minutes.

---

## Two things to know first

**1. If this is your first time, create a new personal workspace.**

Company workspaces often require admin approval to install an app. If you create a new personal workspace you own it yourself, so there are no restrictions, and the free plan is more than enough. The Slack mobile app lets you register several workspaces and switch between them, so nothing gets in the way of receiving notifications. Since threads pile up one per session, a dedicated workspace is actually tidier.

**2. Only one Slack member can send commands into your session.**

The channel is not a permission boundary on its own — anyone invited to it could reply in a thread and push input into your session. So every reply is matched against a **Member ID** you configure, and only that person's replies reach a session. **Until you set it, no reply is delivered at all**: a missing Member ID blocks everyone rather than allowing everyone. Step 6 covers where to enter it.

A **private channel with only you in it** is still the tidier setup.

---

## Step 1 — Create the Slack app

1. Open <https://api.slack.com/apps> in a browser and sign in
2. Choose **Create New App** → **From scratch**
3. Enter a name (for example `Astera`). Pick the workspace to install it into, then **Create App**

You are now in that app's configuration screen. Every setting from here on is done in **this browser screen** — not in the Slack desktop app and not in Astera.

## Step 2 — Grant permissions

In the left menu click **OAuth & Permissions**, then scroll down to **Scopes → Bot Token Scopes**.

Click **Add an OAuth Scope** and add three of them.

| What to add | What the permission does |
|---|---|
| `chat:write` | Posts notifications to the channel |
| `channels:history` | Reads replies in public channels |
| `groups:history` | Reads replies in private channels |

Only one of the last two is actually used, depending on the channel type, but adding both means nothing breaks if you switch channels later.

> ⚠️ **Do not** add `chat:write.public`. It would let the app post in any public channel it was never invited to, which breaks the permission boundary described below.

## Step 3 — Install to the workspace and get the Bot Token

Scroll back to the top of the same screen and click **Install to Workspace** → **Allow**.

Once the installation finishes, a **Bot User OAuth Token** appears right there. It is a long string starting with `xoxb-`. Click **Copy**. (You can always come back and copy it again.)

## Step 4 — Create the channel for notifications and invite the bot

1. Create a new channel in Slack. A **private channel** is recommended
2. Open that channel, type `/invite @Astera` in the message box and press Enter (use your own name if you named the app differently)
   - **If you skip this, no notifications arrive at all.** It is the most common mistake
3. Find the **channel ID** — right-click the channel name → `View channel details` → scroll to the bottom and you will see a value starting with `C`. Copy it

## Step 5 — Turn on replies (Socket Mode)

Everything up to here is enough to receive notifications. This step is for **replying in a thread to send input into the session**.

**5-1. Turn on Socket Mode**

Left menu **Socket Mode** → switch **Enable Socket Mode** on. When it asks for a token name, enter anything (for example `socket`) and click **Generate**.

An **App-Level Token** starting with `xapp-` appears. Copy it. (This is a different token from the `xoxb-` one in Step 3. You need both.)

**5-2. Choose which events to receive — the step that is easy to miss**

Left menu **Event Subscriptions** → switch **Enable Events** on.

Expand **Subscribe to bot events** below it, click **Add Bot User Event** and add two of them.

- `message.channels`
- `message.groups`

Then make sure you click **Save Changes** at the bottom right.

> ⚠️ **If you skip this step, replies do nothing at all.** The connection still comes up normally, which makes it hard to tell what is wrong. This has actually happened.

If an orange banner at the top of the screen asks you to reinstall, click **reinstall your app** and **Allow**. (If there is no banner, move on.)

## Step 6 — Enter the values in Astera

In Astera, open **Settings (⚙) → Slack** tab.

| Field | Value to enter |
|---|---|
| Slack Webhook URL | Keep whatever you were using before; leave it empty if you have none |
| Bot Token | the `xoxb-…` from Step 3 |
| Channel ID | the `C…` from Step 4 |
| App Token | the `xapp-…` from Step 5 |
| Member ID | your own Member ID, starting with `U` — see below |

To find your **Member ID**: in Slack, click your own avatar → **Profile** → the **⋯ (More)** button → **Copy member ID**.

> ⚠️ **Leave the Member ID empty and no reply is delivered at all** — not yours, not anyone's. It is the permission check for the reply path, so an empty value blocks everyone rather than allowing everyone. While it is empty and bot mode is on, the settings screen says so in red.

Click **Save**. It takes effect right away — no need to restart the app, and changing only the Member ID does not even drop the connection.

**Fields you leave empty are not cleared.** Saving is a partial update, so any field you did not touch this time keeps the value you entered before — for example, if you fill in only the App Token and save, the Bot Token and Channel ID you already had stay as they are.

Below the fields it shows which mode it is currently working in.

- **Bot mode** — each session gets its own thread (when both Bot Token and Channel ID are set)
- **Webhook, one-way** — notifications just pile up in the channel, as before
- **No delivery path** — nothing goes out

If you fill in the Bot Token but forget the Channel ID, it quietly falls back to the webhook path. Check the indicator to confirm.

## Step 7 — Verify

When you create a new session, **turn on the `Slack progress notifications` checkbox.**

> ⚠️ **If you do not check this, that session gets no thread at all.** No notifications, no replies. You have to turn it on for every session.

When the session starts, a `🖥 session-name · account` message appears in the channel. If you get this far, notifications work.

Now try **replying in the thread** on that message.

- On a phone: tap the message to open the thread, then type in the box at the bottom
- On a PC: hover over the message and choose **Reply in thread**

Within a few seconds the text is typed into the session terminal, and Enter is pressed for you.

---

## When it does not work

Open the `%APPDATA%\Astera\slack.log` file. If you are using the dev build, it is `%APPDATA%\Astera-dev\slack.log`. (Token values are never written to this file.)

### No notifications arrive at all

1. Did you turn on **`Slack progress notifications`** when creating the session? (Step 7)
2. Did you **invite the bot** to the channel? `/invite @your-app-name` (Step 4-2)
3. Does the settings screen show **Bot mode**? (Step 6)
4. What was written to `slack.log` — see the table below

### Replies do nothing

First check the **Member ID** (Step 6). Leave it empty and every reply is refused, and the refusal is silent — nothing comes back into the thread.

If `slack.log` only has `slack socket connected` and nothing after it → **you skipped step 5-2 (Event Subscriptions).** That is the most common cause.

When you post a reply, one of the lines below is always written to the log. If there is nothing at all, the event is not reaching the app.

```
slack inbound -> injected into session=... chars=...   ← success
slack inbound ignored(other-channel)                   ← you wrote in a different channel
slack inbound ignored(not-thread-reply)                ← you wrote in the channel instead of the thread
slack inbound ignored(member-id-unset)                 ← no Member ID is set yet (Step 6)
slack inbound ignored(not-allowed-user) user=U0123…    ← the sender is not the configured Member ID
```

The `user=` on that last line is **the ID of whoever sent the reply**. If that was you, it is the exact value to paste into the Member ID field — your own entry has a typo.

### A reply comes back saying "This session has ended, so the input could not be delivered"

That thread's session is already finished. **Restarting Astera puts every thread created before it into this state** — closing the app also ends its sessions. Start a new session and reply in the new thread it creates.

### Strings to look for in the log

| If you see this | Cause |
|---|---|
| `invalid_auth`, `not_authed` | The Bot Token is wrong or expired. Copy it again in Step 3 |
| `channel_not_found` | The Channel ID is wrong (Step 4-3) |
| `not_in_channel` | The bot was never invited to the channel (Step 4-2) |
| `missing_scope` | A scope is missing. Check Step 2 and **reinstall the app** |
| `ratelimited`, `status=429` | Slack throttled you for a moment. It retries on its own |
| `slack socket start failed(...)` | The App Token (`xapp-`) is wrong (Step 5-1) |

---

## Good to know

**A reply goes in at any time, regardless of session state.** It reaches Claude even while it is working. Think of it as typing directly into the terminal.

**Multi-line replies are fine.** Line breaks go in as line breaks, and it is submitted only once, at the very end.

**What gets ignored** — messages the bot posted, posts in other channels, channel posts that are not in a thread, message edits and deletions, and empty replies. Replies that are too long (over roughly 4,000 characters) are also refused as a precaution, with a note in the thread.

**A reply from anyone but the configured Member ID is ignored silently.** Nothing is posted back into the thread — a stranger never gets the bot to answer them, and a channel with several people in it does not fill up with warnings. The refusal is written to `slack.log` only, which is where you look if your own reply went nowhere.

**Threads carry over when the account switches.** Even if a usage limit moves the work to another account, notifications keep arriving in the same thread and replies still go into the new session.

**What the bot can see** — only the channels it was invited to. Slack uses the invitation as the permission boundary, so it cannot read anything in channels the bot was not added to. On top of that, Astera narrows it two steps further: it only writes to and reads from the single channel you configured, and within that channel it only accepts replies from the single Member ID you configured.

**If you run two copies of Astera** (the installed build and the dev build) **do not share the App Token.** Connecting twice with the same token makes Slack split replies between the two apps, so a reply can land on the one that does not own the thread. Use a separate app (or a separate workspace) for each.

**You can also edit the config file directly** — `%APPDATA%\Astera\slack.json`. In that case the app has to be restarted for the change to apply. Saving from the settings screen applies immediately, so the screen is usually the better option.

**If posting the session start message (the thread root) fails, notifications go straight to the channel with no thread.** When the root message cannot be posted — a missing bot permission, Slack temporarily not responding, and so on — that session's later notifications (✅ Response complete, 🙋 Input needed, and the rest) are no longer grouped into a thread and pile up one by one at the top level of the channel. Replies need a thread to know which session they belong to, so in this state a reply will not reach that session either. If `slack thread creation failed` shows up in `slack.log`, this is what happened.

### How to reply to a multiple-choice prompt

For a choice question (a notification starting with `❓`) **reply with numbers.** Use commas for a question where you pick several, and a slash to separate multiple questions. The format you need at that moment comes at the bottom of the notification, marked with `💡`.

| Prompt | Example reply |
|---|---|
| One question, pick one | `2` |
| One question, pick several | `1,3` |
| Two questions (several on the first) | `1,3 / 2` |

If the format does not match, **nothing is pressed** and the reason is posted in the thread. A wrong keypress can confirm an item you did not intend and cannot be undone, so when it is ambiguous it chooses not to proceed. Read the reason, fix the format, and reply again.

A question where you pick several is not submitted by Enter alone — it has to go through the `✓ Submit` on screen, and Astera handles that for you. The free-text `Other` item cannot be picked by number — you have to type that in the terminal yourself.

### What to watch out for when replying to an approval prompt

**Be careful when replying with a number to a permission approval (a `🙋 Input needed` notification that carries a tool name).** When you leave a reply in the thread, that text is typed into the session terminal and about 150ms later Enter is pressed automatically. If an item is already highlighted on screen (usually the default), that item can end up approved by the Enter regardless of the number you typed — which is exactly why Astera itself never sends an auto-resume (nudge) to a screen that has choices open. Unlike the choice questions above, here the screen layout cannot be known in advance, so the keys cannot be matched to it. **For important approvals or choices that are hard to undo (approving a file deletion, for example), it is better to check and press it in the terminal yourself than to reply from your phone.**
