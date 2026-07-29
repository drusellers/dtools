# dtools

`dtools` is a small collection of command-line tools I use to manage my own
machines across macOS, Linux, and Windows.

The repository is intentionally packaged with a classic `bin/` + `libexec/`
layout so tools can stay simple shell scripts and can later be distributed by a
Homebrew formula.

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

## Local checkout usage

```bash
git clone git@github.com:drusellers/dtools.git
cd dtools
export PATH="$PWD/bin:$PATH"

dnet --help
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
bin/dnet                 user-facing dispatcher
libexec/dnet/*           implementation scripts used by bin/dnet
.github/workflows/*      automated GitHub release packaging
```

## Releases

Commits pushed to `main` create a GitHub release through GitHub Actions. Each
release includes a `dtools-<tag>.tar.gz` archive and a SHA-256 checksum. A future
Homebrew formula can point at those release artifacts.
