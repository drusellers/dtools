# AGENTS.md

Guidance for AI agents and maintainers working in this repository.

## Project shape

- Keep the packaging simple: public commands live in `bin/`; implementation
  helpers live in `libexec/<tool>/`.
- `bin/dnet` is a dispatcher. Most behavior belongs in `libexec/dnet/*`.
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
bash -n bin/dnet libexec/dnet/*
```

If you add tests later, keep them non-mutating by default. Tests should not
require sudo, change IPv6 settings, or call `launchctl bootstrap/bootout` unless
explicitly isolated behind an opt-in flag.

## Releases

`.github/workflows/release.yml` packages the repository on pushes to `main` and
creates a GitHub release with a tarball and SHA-256 checksum. If the repository
layout changes, ensure the release archive still contains `bin/`, `libexec/`,
`README.md`, and `AGENTS.md`.
