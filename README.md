# dtools

`dtools` is a small collection of command-line tools I use to manage my own
machines across macOS, Linux, and Windows.

The repository is intentionally packaged with a classic `bin/` + `libexec/`
layout so tools can stay simple and can later be distributed by a Homebrew
formula. `dnet` uses shell scripts; `dask`, `dmail`, and `djobs` use Node.js
with no npm dependencies.

## Tools

### `dnet`

`dnet` currently contains macOS network helpers for diagnosing and working
around a Cisco Secure Client VPN + IPv6 blackhole.

When the VPN is connected, some Cisco profiles tunnel IPv4 only and silently
block IPv6. If DNS still returns AAAA records, macOS prefers IPv6 and requests
can hang before falling back to IPv4. `dnet` can:

- generate a read-only network diagnostic report;
- manually turn IPv6 off/on for configured macOS network services;
- install a LaunchDaemon that automatically turns IPv6 off while the VPN is
  connected and restores IPv6 when the VPN disconnects.

### `dask`

`dask` lets an agent ask a batch of questions in a local browser window. Choose
one or several options per question, add optional notes, then send the answers
back to the waiting agent as JSON. Questions appear one at a time: single-choice
selection advances immediately, while multiple-choice questions use **Next**.
Options have number shortcuts: **1–9**, then **0** for the tenth option (any
additional options remain clickable). For multiple-choice questions the number
toggles that option. **R** selects the recommended option(s), advancing on
single-choice questions like a number key. **Enter** performs Next/Send. **N** opens or hides notes;
**Escape** closes the note editor, leaving its content visible as read-only text
and returning focus to **Edit note**. Notes start collapsed.
While typing a note, normal keys are left alone; **⌘ Enter** (or **Ctrl Enter**)
performs Next, validating required choices first. Add a note before selecting a
single-choice answer, or use **Back** to add one later. Optional questions can
be skipped with **Next**. The final screen lets you send the batch; nothing is
delivered until you click **Send answers** or press Enter on that screen.
Requires **Node.js 20+** (`brew install node`).
On macOS it opens your default browser automatically.

```bash
dask ask examples/dask/questions.json
cat examples/dask/questions.json | dask ask -

# Keep stdout for the agent; the browser URL is printed on stderr.
dask ask questions.json > answers.json

# Manual browser launch, with an optional five-minute deadline:
dask ask questions.json --no-open --timeout 300
```

#### Question format

```json
{
  "title": "Help me plan the implementation",
  "questions": [
    {
      "id": "storage",
      "prompt": "How should we store the data?",
      "type": "single",
      "options": [
        { "id": "sqlite", "label": "SQLite", "recommended": true },
        { "id": "json", "label": "JSON files" }
      ]
    },
    {
      "id": "priorities",
      "prompt": "What should I prioritize?",
      "type": "multiple",
      "required": false,
      "options": [
        { "id": "tests", "label": "Automated tests" },
        { "id": "polish", "label": "Visual polish" }
      ]
    }
  ]
}
```

Question IDs must be unique within a batch; option IDs must be unique within
each question. `type` defaults to `single`; `required` defaults to `true`.
Optional questions can have an empty selection and still include a note.
Titles and option descriptions are optional. Notes are always available.
Set `"recommended": true` on an option to show a **Recommended** badge; it is
not preselected. Single-choice questions may recommend at most one option.
All supplied text is displayed as plain text, not HTML or Markdown.

#### Answer format

The command waits until you submit or cancel, then prints one JSON object:

```json
{
  "status": "answered",
  "answers": [
    { "questionId": "storage", "selected": ["sqlite"], "note": "Keep it local." },
    { "questionId": "priorities", "selected": ["tests", "polish"], "note": "" }
  ]
}
```

`selected` is always an array of option IDs, including for single-choice
questions. Answers are returned in question order. Notes default to an empty
string. The agent should check `status` before reading `answers`.

- **Cancel button:** `{"status":"cancelled"}` (exit 0).
- **Timeout:** `{"status":"cancelled","reason":"timeout"}` (exit 0).
- **Ctrl-C / SIGTERM:** `{"status":"cancelled","reason":"interrupted"}` (exit 130).
- **Invalid input or startup failure:** diagnostics on stderr, empty stdout,
  exit 1.

After a successful submission or cancellation, the UI attempts to close its
tab. Browsers often block this for tabs opened by macOS rather than JavaScript;
if so, the confirmation remains visible and you can close the tab manually.
Failed submissions do not trigger auto-close.

Without `--timeout`, the command waits indefinitely. Closing the browser tab
neither submits nor cancels; reopen the URL printed on stderr. Each invocation
is an independent, in-memory batch. Multiple agents can run separate sessions,
but there is no persistent inbox or resume-after-process-exit yet. Configure
an agent's command timeout accordingly, or run it in the background and capture
its stdout in a file.

#### Local-only transport

Each invocation starts a temporary server on an available `127.0.0.1` port with
a random session URL. The browser POSTs answers to this server; the CLI validates
them, writes the JSON result, and shuts down. Nothing is sent to a cloud service
or written to disk by `dask`. Request bodies and question batches are limited to
1 MiB. The server checks Host and POST Origin headers, and serves only its own
UI assets and session endpoints. Treat the session URL as a secret: another
local process with that URL could answer on your behalf.

### `dmail`

`dmail` reads your Outlook / Microsoft 365 mailbox through Microsoft Graph.
Requires **Node.js 20+**. Uses delegated device-code sign-in, not a client secret.
All mailbox requests are read-only: reading a message does **not** mark it read.
It can list and download file attachments. It does not send messages or access
shared mailboxes.

#### Company app registration

In Microsoft Entra, use your existing app registration (or create a
single-tenant registration):

1. Copy the **Directory (tenant) ID** and **Application (client) ID**.
2. Under **Authentication → Advanced settings**, enable **Allow public client
   flows**. Device-code sign-in does not need a redirect URI or client secret.
3. Under **API permissions**, add **Microsoft Graph → Delegated permissions →
   Mail.Read**. `Mail.ReadBasic` cannot read message bodies. Do not add application
   permissions for this flow. `dmail` also requests `offline_access` for refresh.
4. Obtain admin consent if your company's consent policy requires it. Your
   company must permit device-code sign-in; Conditional Access can block it even
   with the correct registration. Ask your administrator rather than bypassing
   those controls.

```bash
dmail login --tenant YOUR_TENANT_ID --client YOUR_CLIENT_ID
# Follow the Microsoft sign-in URL/code printed on stderr.
# Sign in with your company account; no credentials are entered into dmail.

# Alternatively supply registration IDs via environment variables:
export DMAIL_TENANT_ID="YOUR_TENANT_ID"
export DMAIL_CLIENT_ID="YOUR_CLIENT_ID"
dmail login

# Newest 25 inbox messages (summaries, including message IDs):
dmail list
dmail list --limit 10 --unread
dmail list --folder sentitems

# Automatically page through a date range (UTC, since inclusive / before exclusive):
dmail list --folder archive --since 2026-09-23 --before 2026-10-24 --all --max-pages 30

# Search across mailbox folders, including Archive and Sent Items:
dmail search 'eShipping' --from 'Jeff Guttry' --since 2026-09-23
dmail search --to 'dru.sellers@randysww.com' --since 2026-10-01
dmail search 'subject:freight OR subject:shipping' --max-pages 5

# Read all messages in the same conversation, oldest sent first:
dmail thread 'MESSAGE_ID'
dmail thread 'MESSAGE_ID' --html --max-pages 20

# Read the complete message with a plain-text body by default:
dmail read 'MESSAGE_ID'
dmail read 'MESSAGE_ID' --html

# List attachment IDs and metadata (including inline attachments):
dmail attachments 'MESSAGE_ID'
dmail attachments 'MESSAGE_ID' --next 'NEXT_LINK'

# Download one file attachment to an explicit local path:
dmail download 'MESSAGE_ID' 'ATTACHMENT_ID' --output ./report.pdf

# List up to 100 top-level folders, including IDs usable with --folder:
dmail folders

# Follow the @odata.nextLink from a message-list result:
dmail list --next 'NEXT_LINK'

# Review local command usage (no mailbox access or login required):
dmail usage --since 2026-10-01 --before 2026-11-01

# Disable usage logging for a command (or export this variable):
DMAIL_USAGE_LOG=0 dmail list

# Remove locally cached credentials (does not revoke Microsoft's session):
dmail logout
```

Results are Microsoft Graph JSON on stdout, including `value` and, when more
messages exist, `@odata.nextLink`. Diagnostics/sign-in instructions go to stderr;
errors exit 1 with no JSON output. Message bodies, including HTML returned by
`--html`, are untrusted content; the CLI never renders or executes them.
`folders` currently lists only the first page of top-level folders.

`list` stays single-page unless `--all` is supplied. `--limit` is the page size
(1–100; default 25 for list, 100 for search). `--all`, `search`, and `thread`
follow pagination automatically, bounded by `--max-pages` (1–100, default 10).
`list --next NEXT_LINK --all` can continue a bounded result; do not combine
`--next` with filters or `--limit`. Both slash-style and Microsoft’s
`mailFolders('…')` continuation URLs are accepted, only on the Graph message
endpoint.

Automatically paged results include `coverage` with `count`, `pages`, `complete`,
and `reason` (`exhausted`, `max_pages`, or `search_limit`), plus `@odata.nextLink`
when available. A request failure exits nonzero without emitting partial JSON.
`complete` means the endpoint was exhausted, **not** that every relevant email
was necessarily found. Search uses Microsoft's indexed KQL search, with its
indexing delay and 1,000-result ceiling. At 1,000 results coverage is conservatively
incomplete even without a next link; narrow the dates/query to retrieve more.

`search` accepts one quoted KQL expression as its optional positional query;
`--from` and `--to` add quoted name/address phrases, ANDed with the query and
date bounds. These structured person values cannot contain quotes, backslashes,
or newlines. Dates use valid `YYYY-MM-DD` values, inclusive `--since` and
exclusive `--before`; list uses UTC midnight, while search uses Graph's received-date
search semantics. Search order is Microsoft's received-time order, not relevance.
No attachment text extraction or local mailbox index is created.

`thread` resolves a message's `conversationId` and retrieves full message bodies
across mailbox folders, including your replies. It sorts the retrieved messages
by `sentDateTime` (falling back to received time), oldest first. Capped threads
are not guaranteed to contain the earliest/latest messages; check coverage.
Conversation grouping is Microsoft's, not a subject-line heuristic: renamed,
forwarded, or separate conversations may need additional searches. Summary and
read results include conversation ID, parent folder ID, and sent timestamp.
Outlook `webLink` values remain available for citations.

`attachments` returns metadata only, with `@odata.nextLink` when another page
exists. `download` supports file attachments, not attached Outlook items or
reference links. It returns JSON with the attachment ID, original name, saved
absolute path, and byte size; file contents never go to stdout. The destination's
parent directory must exist. Existing files (including symlinks) are never
overwritten; new files use mode 600 on POSIX. Downloads are buffered in memory.
Attachment names and contents are untrusted; downloads are never opened or
executed. No additional Graph permissions are required.

Tenant/client IDs are remembered after login; environment variables override
cached IDs. An override for a different tenant/client requires a fresh login.
Access and refresh tokens are cached in
`${XDG_CONFIG_HOME:-~/.config}/dtools/dmail/tokens.json` with directory mode 700
and file mode 600 on POSIX systems. Tokens are **not encrypted at rest**; use
full-disk encryption and never commit, share, or back up this cache insecurely.
Set `DMAIL_HOME` to a dedicated private directory for a separate account/cache.
On Windows, secure that directory with user-only ACLs; POSIX modes are not an ACL
replacement. Tokens refresh automatically; revoked/expired sessions require
`dmail login` again. Concurrent commands share a cache but do not lock refreshes;
avoid simultaneous refresh/login/logout operations on the same cache.

#### Private usage history

Commands are logged by default to `DMAIL_HOME/usage/YYYY-MM-DD.jsonl`, or
`${XDG_CONFIG_HOME:-~/.config}/dtools/dmail/usage/` when `DMAIL_HOME` is unset.
The directory uses mode 700 and files use mode 600 on POSIX. Files rotate daily
in UTC; each logged command prunes files older than today plus the preceding
89 days. Inactive installations do not run a background cleanup job. Files are
local and unencrypted; secure Windows ACLs and full-disk encryption still apply.
Set `DMAIL_USAGE_LOG=0` to disable new logging (existing history is retained).

Each JSONL event has a schema version, timestamp, command name, option names,
explicit numeric page-size/page-limit values, duration, success/failure, and
available result counts, pages, coverage status/reason, or downloaded byte count.
Other option values—including dates, people, folders, output paths, tenant/client
IDs, and continuation URLs—are recorded only as presence booleans. Positional
queries and message/attachment IDs are also presence booleans. Unknown commands
are recorded as `unknown`; invalid arguments do not record any option values.
No message bodies, subjects, addresses, filenames, query text, credentials,
response objects, or raw errors/stack traces are written. Error categories are
allowlisted (`invalid_arguments`, `network`, `http_NNN`, or `command_failed`).
Failed commands have no result statistics, even if some requests succeeded.

`dmail usage [--since YYYY-MM-DD] [--before YYYY-MM-DD]` returns a local JSON
summary by command: calls, failures, total/average/maximum duration, returned
item/page totals, incomplete-result counts and coverage reasons, error counts,
and option-use frequencies. Dates use UTC, inclusive since/exclusive before;
defaults cover retained history. Repeated results are counted per invocation,
not deduplicated messages. Malformed log records are counted in `skippedLines`.
Help and usage queries do not log themselves; usage needs no login and does not
contact Microsoft. Logging failures issue a generic stderr warning without
changing command results or exit status. Interrupted/killed processes may not
produce an event. `logout` removes credentials, not usage history.

### `djobs`

`djobs` provides a focused, read-only view of `launchctl list` and manages
user-level interval schedules. Requires **macOS and Node.js 20+**. Run it as
your normal user in your macOS login session, not with sudo. Listing includes
loaded jobs plus installed djobs-managed schedules, not every installed plist
or system daemon. A loaded job without a PID is not currently running.

```bash
djobs                         # hide com.apple.* and configured exclusions
djobs worker                  # case-insensitive label substring
djobs --running               # only jobs with a PID
djobs --json                  # job details including loaded and schedule
djobs --all                   # bypass default and configured exclusions
djobs list --running worker   # optional explicit list command
djobs --config ./jobs.json
djobs ignore 'com.microsoft'   # persist an exclude prefix
djobs ignore 'com.google.' --config ./jobs.json
```

The table shows PID (`-` when not running), last exit status (not a health
indicator), label, loaded/unloaded state, and schedule, sorted by label.
JSON adds `loaded` (boolean) and `schedule` (interval string, or `null` for
non-managed jobs). Missing PID or unknown exit status is `null` in JSON and
`-` in the table. Unloaded managed schedules remain visible; `--running` hides
them. Exclusions and searches also apply to managed schedules.
Empty results are a header-only table or `[]`; errors go to stderr and exit 1.

Optional user config lives at
`${XDG_CONFIG_HOME:-~/.config}/dtools/djobs/config.json`.
Set `DJOBS_CONFIG` or use `--config PATH` to override it (`--config` wins).
For listing, the default file may be absent; explicitly selected files must
exist. `djobs ignore PREFIX` creates the selected config and parent directories
if needed, preserves existing exclusions, and skips duplicate prefixes. It
writes the config atomically and never calls launchctl. Invalid existing config
is not overwritten. Avoid simultaneous config edits (there is no write lock).

```json
{
  "excludePrefixes": ["com.google.", "com.microsoft."],
  "excludeLabels": ["homebrew.mxcl.example"]
}
```

These case-sensitive, literal exclusions add to the built-in `com.apple.`
prefix. `djobs ignore 'com.microsoft'` hides every label starting with that
literal text; use `com.microsoft.` to restrict it to that namespace. No regex
or glob syntax is needed. `--all` bypasses exclusions but
still applies search and `--running`. Unknown config keys or invalid config
fail rather than silently showing an unfiltered list.
See `examples/djobs/config.json` for a starting point.
No arbitrary arguments are passed through to launchctl. Listing only uses
`/bin/launchctl list`; scheduling/removal explicitly manage LaunchAgents.

#### Interval schedules

```bash
djobs schedule './scripts/run.sh' 2h --name thing
djobs schedule './scripts/run.sh' 15m --name other --cwd ./project
djobs list
djobs unschedule thing
```

Scripts are run with `/bin/bash -- /absolute/path/to/script`, not an interactive
or login shell. They must be Bash-compatible and readable; executable permission
is not required. Resolve your own dependencies inside the script, including mise.
Use an absolute mise path (find it with `command -v mise`) or set PATH explicitly;
launchd does not inherit your interactive shell setup. Script and working-directory
paths are saved absolutely. The working directory defaults to your current
directory when scheduling; `--cwd` overrides it.

Intervals are positive whole numbers followed by `s`, `m`, `h`, or `d` (e.g.
`30s`, `15m`, `2h`, `1d`), capped at 2147483647 seconds. This uses launchd's
`StartInterval`: triggers during sleep or while the job is already running are
skipped. It does not wake the laptop, catch up missed runs, or run immediately
when installed. Intervals are not precise wall-clock deadlines and launchd may
throttle frequent executions. User LaunchAgents require a logged-in session.

`--name` is required: 1–80 letters, digits, underscores, or hyphens, beginning
with a letter or digit. A name produces the label `com.drusellers.NAME` and
`~/Library/LaunchAgents/com.drusellers.NAME.plist`. Schedule metadata lives in
`~/Library/Application Support/dtools/djobs/`; stdout and stderr append to
`~/Library/Logs/dtools/djobs/NAME.stdout.log` and `NAME.stderr.log`. Logs are not
rotated automatically. Filter config overrides do not change schedule storage.

Existing labels or plist files are never overwritten. To change an interval,
unschedule the managed job first. Scheduling loads the agent into `gui/UID`;
removal verifies ownership, unloads it (stopping any current run), and removes
its plist and metadata, but keeps logs. Externally changed plists are refused.
If loading fails, installed files are kept and the error explains how to remove
them. Schedule edits use a lock; an interrupted edit may leave a `.lock`
directory in the metadata directory, which must be removed after confirming no
other edit is active. Tests use fake launchctl calls, never actual job installs.

## Local checkout usage

```bash
git clone git@github.com:drusellers/dtools.git
cd dtools
export PATH="$PWD/bin:$PATH"

dnet --help
dask --help
dmail --help
djobs --help
```

## `dnet` commands

```bash
dnet netcheck [host] [--save]       # read-only VPN/IPv6 diagnostics
dnet status                         # IPv6 + guard daemon status
dnet off                            # disable IPv6 on managed services
dnet on                             # restore IPv6 to Automatic
dnet toggle                         # flip IPv6 state on managed services
dnet guard dry-run                  # preview automatic guard behavior
dnet install-guard                  # install/refresh LaunchDaemon
dnet uninstall-guard                # remove LaunchDaemon
```

The default managed services are `Wi-Fi` and `Belkin USB-C LAN`. Override them
for one run:

```bash
DNET_SERVICES="Wi-Fi:Thunderbolt Bridge" dnet guard dry-run
```

Persist them for both manual commands and the LaunchDaemon:

```bash
echo 'Wi-Fi:Thunderbolt Bridge' | sudo tee /usr/local/etc/dtools/dnet/services
```

Install the automatic guard:

```bash
dnet guard dry-run
dnet install-guard --services "Wi-Fi:Belkin USB-C LAN"
dnet status
```

Uninstall it:

```bash
dnet uninstall-guard
```

## Layout

```text
bin/dnet                 network command dispatcher
bin/dask                 browser-question command launcher
bin/djobs                filtered launchd job listing launcher
bin/dmail                Microsoft 365 mailbox command launcher
libexec/djobs/*          listing, config filtering, interval schedules, and tests
libexec/dmail/*          Graph client, device-code authentication, and tests
libexec/dnet/*           network implementation scripts
libexec/dask/*           question server, browser UI, and tests
examples/dask/*          example question batches
examples/djobs/*         example job exclusions
.github/workflows/*      checks and automated GitHub release packaging
```

## Checks

These checks do not change networking settings, use sudo, or launch a browser:

```bash
bash -n bin/dnet bin/dask bin/dmail bin/djobs libexec/dnet/*
node --check libexec/dask/ask.mjs
node --check libexec/dask/app.js
node --check libexec/dmail/mail.mjs
node --check libexec/dmail/usage.mjs
node --check libexec/djobs/jobs.mjs
node --check libexec/djobs/schedules.mjs
node --test libexec/dask/*.test.mjs libexec/dmail/*.test.mjs libexec/djobs/*.test.mjs
```

## Releases

Commits pushed to `main` create a GitHub release through GitHub Actions. Each
release includes a `dtools-<tag>.tar.gz` archive and a SHA-256 checksum. A future
Homebrew formula can point at those release artifacts.

## License

Copyright 2026 Dru Sellers. Licensed under the [Apache License 2.0](LICENSE).
