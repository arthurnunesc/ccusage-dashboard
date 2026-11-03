# Native deployment runbook

All deployment source is versioned in this repository. Installed scripts and
systemd files are copies, not server-only code. Private configuration, history,
dependencies, runtimes, logs, and deployment state must not be committed.

This runbook targets Linux x86_64 with user systemd 252, Python 3, Git, and
outbound HTTPS. It needs no Docker, root service, public SSH, or router forwarding.
The runtime pin is `.bun-version`; the reviewed archive digest is in
`scripts/deploy/runtime.py`. A runtime upgrade requires updating both deliberately.

## Before installing

Get approval for the actual server changes. Confirm:

- The reviewed commit is on `main` and its latest **Checks** push run passed,
  including native contract, deployment, and browser tests.
- The target account is `agent`; its existing history can be read without moving
  data, changing agent configuration, or copying anything from the Mac.
- At least 1 GiB is free for staging, and space remains for the previous release.
  This is a safety floor, not an estimate of the full retained installation size.
- `192.168.1.52:8766` is available, user lingering is enabled, and proposed paths
  and unit names do not belong to another installation. Recheck these facts.
- Usage summaries may be exposed without authentication to the trusted LAN/VPN.
  Host/Origin checks are not access control. HTTP is not encrypted on the LAN.
  Do not expose this dashboard publicly. Plan authentication/TLS separately if
  the private-network policy is not sufficient.

Do not alter LXC networking or disable a firewall. If a rule is needed, review
the actual client source addresses and approve a narrow rule for port 8766.

## Bootstrap, then verify before enabling updates

On the server, obtain a separate checkout of the reviewed CI-green commit. Do
not copy the Mac working tree or use an agent's project checkout as the Git cache.
From that checkout:

```sh
python3 -B scripts/deploy/install.py --dry-run
```

Review the exact paths. After approval:

```sh
python3 -B scripts/deploy/install.py --apply
```

Bootstrap copies controls and units only. It does not download Bun, start the
dashboard, reload systemd, or enable the timer. Existing identical controls are
a no-op; differing controls require explicit maintenance, not silent overwrite.

Review `~/.config/ccusage-dashboard/dashboard.env` (mode 0600). The supplied
example opts in to `.52:8766` only. Supported syntax is unquoted `KEY=value`,
blank lines, and `#` comments; no shell substitutions, escapes, or inline comments.
Values cannot contain quotes, backslashes, dollar signs, backticks, or percent
signs. Do not put tokens, HOME, PATH, Bun options, or secrets here. Supported keys
are the documented app settings plus `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` for source discovery. All
explicit source/config/executable paths must be absolute.

Keep custom source/pricing configuration in a private file outside release trees,
then set its absolute `CCUSAGE_CONFIG` path. Preserve offline pricing unless an
online refresh is intentional. No custom config is required for default discovery.

After approval for runtime installation and app startup:

```sh
systemctl --user daemon-reload
python3 -B ~/.local/lib/ccusage-dashboard/manage.py update --dry-run
python3 -B ~/.local/lib/ccusage-dashboard/manage.py update
```

The dry-run is a description only: no GitHub request, file change, or service
operation. The real update checks exact `main` and CI, downloads a checksum-pinned
Bun if needed, installs frozen production dependencies, then starts the app and
checks health plus a real usage scan. It does not enable the timer. GitHub metadata
is public and unauthenticated; if access is denied, resolve read access explicitly.
There is no fallback to an unchecked commit or automatic credential installation.

Read the result and journal:

```sh
python3 -B ~/.local/lib/ccusage-dashboard/manage.py status
systemctl --user status ccusage-dashboard.service
journalctl --user -u ccusage-dashboard.service -u ccusage-dashboard-update.service -n 100
curl --fail http://192.168.1.52:8766/api/health
```

Health alone does not prove usage collection. Load the dashboard from a LAN
browser, check usage and refresh, then repeat from a genuinely off-LAN device
connected to WireGuard. Compare a small native-report sample where data exists.
Empty valid history is acceptable; missing sources/accounting are not proof of
zero usage or complete compatibility with upgraded agents.

After these checks and approval for persistent operation:

```sh
systemctl --user enable ccusage-dashboard.service
systemctl --user enable --now ccusage-dashboard-update.timer
systemctl --user list-timers ccusage-dashboard-update.timer
```

No server reboot is needed. The app is already running from the manual update.
Existing user lingering permits startup without an interactive login. Verify
lifecycle behavior without restarting T3 or rebooting the whole host.

## Updates and release state

The timer checks after boot, then about every five minutes with up to 30 seconds
of jitter. Only exact `main` with the latest successful Checks push run/attempt
can activate. PR runs and older green commits do not qualify. Merges/pushes have
to finish CI before the next check can deploy them.

The app source and production dependencies are staged in:

```text
~/.local/share/ccusage-dashboard/releases/<full-commit-sha>/
```

`current` and `previous` are release symlinks. Each release has
`.deployment-release.json` with its SHA, Bun version, and CI run ID. Recorded state
is `~/.local/state/ccusage-dashboard/deployment.json`. `status` reports this state;
it does not actively check a process or fetch GitHub. Readiness additionally checks
the running unit's PID working directory, existing health route, and non-stale
usage response. A short restart and cold cache are expected during an update.

To trigger a check without waiting:

```sh
python3 -B ~/.local/lib/ccusage-dashboard/manage.py update
```

All mutations share an exclusive deployment lock. Network/CI failures leave the
healthy app running. GitHub rate-limit responses record a retry time. Known
staging transport failures and timeouts retry after five minutes; other install
failures record the failed SHA because a tool's nonzero exit does not reliably
distinguish a network fault from a broken package. Activation failure restores and checks the last
healthy release. A failed first install is stopped, with no invented rollback.

## Pause, retry, rollback

```sh
python3 -B ~/.local/lib/ccusage-dashboard/manage.py pause
python3 -B ~/.local/lib/ccusage-dashboard/manage.py status
python3 -B ~/.local/lib/ccusage-dashboard/manage.py resume
```

Pause leaves the app running. Resume permits future timer checks but does not
deploy immediately. Failed SHAs stay suppressed until a new SHA or explicit retry:

```sh
python3 -B ~/.local/lib/ccusage-dashboard/manage.py retry
python3 -B ~/.local/lib/ccusage-dashboard/manage.py resume
python3 -B ~/.local/lib/ccusage-dashboard/manage.py update
```

To restore the previous healthy release:

```sh
python3 -B ~/.local/lib/ccusage-dashboard/manage.py rollback
```

Manual rollback pauses automatic updates so the timer cannot undo it. Review the
cause and branch state before resuming. The updater records the last accepted
observed `main` head independently of the active release, including heads whose
CI or staging failed. Non-fast-forward changes to `main` require
manual review; do not reset state to bypass that check without investigation.

Interrupted activations retain a pending transaction. The next unpaused update
restores the last healthy release before checking GitHub. If rollback fails,
updates are paused and the app is stopped to prevent restart loops. Inspect
`deployment.json`, release metadata, runtime files, and the journal. Repair the
last healthy release/config under the lock, then use `resume` to retry pending
recovery. If no healthy release exists, fix the first-install cause and explicitly
retry. Do not delete state or change symlinks while an updater is running.

## Maintenance and removal

Automatic updates change app releases only. Installer, updater, launcher, runtime
digest allowlist, units, and private config are not self-replaced. A change to
that control layer needs a reviewed maintenance window:

1. Pause updates and stop the update timer/oneshot; wait for the deployment lock
   to be released. Inspect any pending transaction before proceeding.
2. Back up the exact installed control files and units to a private receipt path.
3. Review the diff against the desired GitHub commit. Replace only those files
   explicitly approved, retain their ownership/mode, and reload user systemd.
4. Run a manual update/readiness check, then restore the timer and resume only
   after verification. Restore the backed-up controls on maintenance failure.

Normal successful updates retain active and previous healthy releases and delete
only older validated release directories. An update also removes private staging
trees with valid updater ownership markers, under the deployment lock. Unmarked
or unrelated files/staging directories are not swept. Downloaded runtimes are
retained for explicit reviewed cleanup; remove
one only after confirming no retained release needs it. If disk space is low, the
updater fails closed; never free space by deleting native agent history or the
last healthy release.

For removal, first pause, stop/disable the timer, stop the updater, then stop/disable
the app. Remove only the three `ccusage-dashboard*` unit files listed in this
repository and reload user systemd. Inspect ownership and remove only this app's
dedicated control, release/runtime/cache, and state directories. Preserve private
config until backed up or explicitly approved for deletion. Do not remove HOME,
agent stores, shared XDG directories, user lingering, T3 units, or global runtimes.

## Repository validation

```sh
bun run check
bun --no-env-file scripts/tests.js deploy
bun run test:e2e
```

The deployment suite uses disposable HOME/state trees and fake network, tools,
and systemd operations. It does not install services, download runtimes, scan
production history, or verify the actual Linux host. Live LAN/WireGuard and
systemd checks remain separate approved rollout steps.
