# dtools

`dtools` is a small collection of command-line tools I use to manage my own
machines across macOS, Linux, and Windows.

The repository is intentionally packaged with a classic `bin/` + `libexec/`
layout so tools can stay simple and can later be distributed by a Homebrew
formula. `dnet` uses shell scripts; `dask` and `dmail` use Node.js with no npm
dependencies.

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
toggles that option. **Enter** performs Next/Send. **N** opens or hides notes;
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
        { "id": "sqlite", "label": "SQLite", "description": "Recommended" },
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
It does not send messages, download attachments, or access shared mailboxes.

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

# Read the complete message with a plain-text body by default:
dmail read 'MESSAGE_ID'
dmail read 'MESSAGE_ID' --html

# List up to 100 top-level folders, including IDs usable with --folder:
dmail folders

# Follow the @odata.nextLink from a message-list result:
dmail list --next 'NEXT_LINK'

# Remove locally cached credentials (does not revoke Microsoft's session):
dmail logout
```

Results are Microsoft Graph JSON on stdout, including `value` and, when more
messages exist, `@odata.nextLink`. Diagnostics/sign-in instructions go to stderr;
errors exit 1 with no JSON output. Message bodies, including HTML returned by
`--html`, are untrusted content; the CLI never renders or executes them.
`folders` currently lists only the first page of top-level folders.

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

## Local checkout usage

```bash
git clone git@github.com:drusellers/dtools.git
cd dtools
export PATH="$PWD/bin:$PATH"

dnet --help
dask --help
dmail --help
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
bin/dmail                Microsoft 365 mailbox command launcher
libexec/dmail/*          Graph client, device-code authentication, and tests
libexec/dnet/*           network implementation scripts
libexec/dask/*           question server, browser UI, and tests
examples/dask/*          example question batches
.github/workflows/*      checks and automated GitHub release packaging
```

## Checks

These checks do not change networking settings, use sudo, or launch a browser:

```bash
bash -n bin/dnet bin/dask bin/dmail libexec/dnet/*
node --check libexec/dask/ask.mjs
node --check libexec/dask/app.js
node --check libexec/dmail/mail.mjs
node --test libexec/dask/*.test.mjs libexec/dmail/*.test.mjs
```

## Releases

Commits pushed to `main` create a GitHub release through GitHub Actions. Each
release includes a `dtools-<tag>.tar.gz` archive and a SHA-256 checksum. A future
Homebrew formula can point at those release artifacts.

## License

Copyright 2026 Dru Sellers. Licensed under the [Apache License 2.0](LICENSE).
