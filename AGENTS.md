# AGENTS.md

Guidance for AI agents and maintainers working in this repository.

## Project shape

- Keep the packaging simple: public commands live in `bin/`; implementation
  helpers live in `libexec/<tool>/`.
- `bin/dnet` is a dispatcher. Most behavior belongs in `libexec/dnet/*`.
- `bin/dask` launches the dependency-free Node.js 20+ implementation in
  `libexec/dask/`. Keep stdout reserved for JSON results during `dask ask`;
  diagnostics and the session URL belong on stderr.
- `bin/dmail` launches the dependency-free Node.js 20+ Microsoft Graph client in
  `libexec/dmail/`. Keep mailbox access read-only and stdout reserved for JSON
  results (except help). Never log or commit cached access/refresh tokens.
  Local usage logs must allowlist command shapes and numeric stats only: never
  log queries, people, message IDs, paths, response content, or raw errors.
  Keep logs private, daily-rotated, and retained for 90 days; respect
  `DMAIL_USAGE_LOG=0`. Logging failures must not break mailbox commands.
- `bin/djobs` launches the dependency-free Node.js 20+ implementation in
  `libexec/djobs/`. Listing is read-only; `ignore` only changes filter config.
  `schedule`/`unschedule` manage user LaunchAgents named `com.drusellers.NAME`;
  never overwrite unrelated jobs or unload jobs without verifying ownership.
  Use `StartInterval`, not calendar/cron scheduling. Scripts run via `/bin/bash`.
  Tests must use temporary homes and fake launchctl, never real job installs.
  User exclusions add to `com.apple.`; do not forward arbitrary launchctl options.
- `bin/dtodo` launches the dependency-free Node.js 20+ implementation in
  `libexec/dtodo/`. Keep Things/Wrike access read-only and stdout JSON-only
  (except help). Things uses public macOS scripting, never database writes or
  private experimental APIs; tests must not automate the real app. Wrike uses
  `WRIKE_TOKEN` or the private `dtodo login` credential cache, GET-only requests
  to allowlisted hosts, and only tasks assigned to the current user, with task
  permalinks. Login verifies a hidden-prompt token before atomic private storage;
  logout removes the cache only. Never log tokens or task content, or commit caches.
  Usage logs follow dmail's private daily rotation, 90-day retention, numeric/
  command-shape allowlists, and non-fatal failures; respect `DTODO_USAGE_LOG=0`.
  Tests use fake Wrike responses and temporary log homes, never real credentials.
- `dnet` is currently macOS-specific. Future tools may target Linux or Windows,
  but do not make `dnet` pretend to support platforms it cannot safely manage.

## Shell conventions

- Use `#!/usr/bin/env bash`.
- Stay compatible with macOS Bash 3.2:
  - no associative arrays;
  - no `mapfile` / `readarray`;
  - avoid Bash 4+ features.
- Avoid GNU-only flags because these scripts run on stock macOS.
- Quote variables, especially paths and network service names.
- Keep root-running scripts small and auditable.

## `dnet` maintenance notes

- Managed services are configured with `DNET_SERVICES` as a colon-separated list
  or persisted in `/usr/local/etc/dtools/dnet/services`.
- The LaunchDaemon label is
  `com.drusellers.dtools.dnet.vpn-ipv6-guard`.
- The installed guard helper defaults to
  `/usr/local/libexec/dtools/dnet/vpn-ipv6-guard`.
- Do not run commands that toggle networking or install/remove launchd jobs
  unless the user explicitly asks. Prefer `dnet guard dry-run` for validation.

## Checks before committing

Run syntax checks for shell files:

```bash
bash -n bin/dnet bin/dask bin/dmail bin/djobs bin/dtodo libexec/dnet/*
node --check libexec/dask/ask.mjs
node --check libexec/dask/app.js
node --check libexec/dmail/mail.mjs
node --check libexec/dmail/usage.mjs
node --check libexec/djobs/jobs.mjs
node --check libexec/djobs/schedules.mjs
node --check libexec/dtodo/auth.mjs
node --check libexec/dtodo/todo.mjs
node --check libexec/dtodo/wrike.mjs
node --check libexec/dtodo/things.mjs
node --check libexec/dtodo/things.js
node --check libexec/dtodo/usage.mjs
node --test libexec/dask/*.test.mjs libexec/dmail/*.test.mjs libexec/djobs/*.test.mjs libexec/dtodo/*.test.mjs
```

Keep tests non-mutating by default. The `dask` tests use ephemeral loopback
servers and do not open a browser. Tests should not
contact Microsoft or require real mailbox credentials. Tests should not
require sudo, change IPv6 settings, or call `launchctl bootstrap/bootout` unless
explicitly isolated behind an opt-in flag.

## Releases

`.github/workflows/release.yml` packages the repository on pushes to `main` and
creates a GitHub release with a tarball and SHA-256 checksum. If the repository
layout changes, ensure the release archive still contains `bin/`, `libexec/`,
`README.md`, and `AGENTS.md`.
