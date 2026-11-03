# Native deployment on the agent host

Status: repository implementation approved, independently reviewed, and validated
locally. Live rollout status is recorded separately in deployment state, not this
design document. This document alone does not authorize installation, server
configuration changes, service enabling, or setup-changing server tests.
See the [runbook](native-deployment.md) for implemented commands and limits.

## Goal and scope

Run the existing all-in-one dashboard on `agent@192.168.1.52`. It reads history
already present on that host. Deploy and verify it **before copying Mac history**.

Target URL: **http://192.168.1.52:8766**, from the LAN or the existing WireGuard
route to `192.168.1.0/24`.

```text
GitHub main + successful Checks run
                  |
          outbound HTTPS checks
                  v
.52: updater -> versioned release -> native dashboard -> local agent history
                                           |
                              LAN / WireGuard browser
```

No Docker, separate collector, report transfer, importer, database, public SSH,
router forwarding, new LXC bridge, or application build step is needed. T3
Connect does not publish this separate dashboard.

### Repository ownership

GitHub is the source of truth for all implementation code: the application,
installer, launcher, updater, systemd templates, example configuration, tests,
and runbook. Server-installed scripts and units are copies of reviewed repository
files, not server-only code. Version control their maintenance procedure too.

Keep only private configuration, credentials, agent history, downloaded runtimes
and dependencies, logs, and generated deployment state outside Git. Commit safe
examples, never real secrets or private source paths.

## Confirmed starting point

- Origin: `https://github.com/arthurnunesc/ccusage-dashboard.git`.
- `.52` can read GitHub refs over HTTPS. During inspection, `main` was
  `1cf783ccbe909e934d5e8b805a02d5b8ce3c0b83`; resolve it again at deployment.
- Git, curl, Python 3, flock, and systemd 252 are present. Bun is absent.
- User lingering is enabled. Port `192.168.1.52:8766` and the proposed dashboard
  directories and systemd names are unused. About 6 GB was free; recheck first.
- `src/server.js` binds only to `127.0.0.1` and rejects other Host values.
  Refresh also requires an exact HTTP Origin match and `X-ccusage-refresh: 1`.
- `GET /api/health` already exists. It checks HTTP liveness, **not** whether a
  native usage scan succeeds. `GET /api/usage` is needed for readiness.
- `ccusage` is pinned to `20.0.33`. Workflow `Checks` in
  `.github/workflows/ci.yml` pins Bun `1.3.11` and runs both `bun run check` and
  E2E. `check` alone does not include E2E.
- Compatibility and accounting completeness with the upgraded native agents
  are not established. A successful deployment must not imply usage parity.

The local working tree has unrelated `package.json`, `bun.lock`, research, and
test-script changes. Preserve them. Do not bulk-stage, discard, or silently
include them in deployment work. Ship only reviewed changes through GitHub.

## 1. Add explicit private-network configuration

Keep local operation unchanged. Extend `src/config.js`, `src/server.js`, and
their configuration types with:

| Proposed setting | Default | Deployment value |
| --- | --- | --- |
| `CCUSAGE_BIND_ADDRESS` | `127.0.0.1` | `192.168.1.52` |
| `CCUSAGE_ALLOWED_HOSTS` | Actual-port localhost and loopback hosts | `192.168.1.52:8766` |
| `PORT` | `8766` | `8766` |

Configuration contract:

- For this scope, support an explicit IPv4 listen address, not automatic network
  discovery or a wildcard bind. Reject invalid, unspecified, and multicast
  addresses. A non-loopback bind requires an explicit nonempty Host allowlist.
- The comma-separated allowlist contains exact `host:port` authorities. Reject
  empty entries, wildcards, credentials, schemes, paths, and invalid ports.
  Explicit entries replace, rather than widen, the default list.
- Retain ephemeral port support for default local tests. Non-loopback deployment
  requires a fixed, nonzero port and matching allowlist ports.
- Check Host before serving any route. Keep the exact same-origin HTTP refresh
  check and custom header; do not add permissive CORS, forwarded-host trust, or
  a separate arbitrary-origin setting. HTTPS/reverse proxies are out of scope.
- Retain CSP, no-store, fixed public errors, scan limits, single-flight refresh,
  stale-data recovery, and graceful child-process shutdown.
- Log the actual configured listen address instead of a hardcoded localhost URL.

**Access policy:** bind only to the LXC's private IP. Check existing host/LXC
firewall rules and verify LAN/WireGuard access. If blocked, propose a narrow
allow rule for the actual required source networks and port; get approval before
applying it. Do not disable a firewall or change routing to make a test pass.

Host/Origin checks prevent some browser attacks; they are **not authentication**.
This HTTP dashboard exposes usage summaries to any client allowed by the network.
Confirm that this is acceptable for the trusted LAN/VPN. If not, pause and plan
authentication/TLS separately. Do not forward this port to the internet.

## 2. Define the native installation

Run as the existing `agent` account, with its real HOME and required source-path
environment. Do not move, rewrite, import, or change permissions on agent stores.
Inspect source locations without printing credentials. Add private overrides
only when discovery needs them.

Proposed layout, all owned by `agent`:

```text
~/.local/share/ccusage-dashboard/
  repository.git/             # dedicated Git cache, never a developer checkout
  releases/<commit-sha>/       # source plus release-local production dependencies
  runtimes/<bun-version>/      # version-specific Bun, no global launcher changes
  current -> releases/<sha>
  previous -> releases/<sha>
~/.local/lib/ccusage-dashboard/ # reviewed launcher and updater control scripts
~/.config/ccusage-dashboard/
  dashboard.env               # private runtime settings, mode 0600
  ccusage.config.json          # host-specific source/pricing settings if needed
~/.local/state/ccusage-dashboard/
  deploy.lock
  deployment.json             # active/previous/pending/failed SHA and CI run ID
  update-paused               # optional operator pause marker
~/.config/systemd/user/
  ccusage-dashboard.service
  ccusage-dashboard-update.service
  ccusage-dashboard-update.timer
```

Implementation rules:

- Add `.bun-version` containing `1.3.11`; make CI read it with
  `setup-bun`'s `bun-version-file`. Keep `ccusage` at `20.0.33`. Dependency or
  runtime upgrades remain separate, deliberate changes.
- After approval, install the pinned Bun in the dashboard-specific runtime
  directory. Verify the downloaded release and `bun --version`; do not replace
  Node, Codex, OpenCode, T3, or their launchers. A future Bun change must retain
  the previous release's runtime for rollback.
- Stage exact committed source, not a copy of this Mac checkout. Install using
  the pinned runtime and `bun install --production --frozen-lockfile`, with
  automatic `.env` loading disabled. Keep optional platform-native dependencies
  enabled. Verify the resolved ccusage native executable before activation.
- No Chromium or development dependencies on the live host. Run the full test
  suite in CI, not against production HOME or agent history.
- Keep private configuration outside releases. Do not source arbitrary shell
  text or load a checked-in `.env`. Set `CCUSAGE_CONFIG` to an absolute external
  path if a host-specific config is needed. Preserve offline pricing by default.
- Use a small launcher that resolves `current` once, selects that release's
  pinned runtime, changes into that exact release, and execs
  `bun --no-env-file src/server.js`. Do not use watch mode or `bunx` downloads.

The app user unit loads the external EnvironmentFile, sets HOME/PATH explicitly,
uses `UMask=0077`, and sends logs to the user journal. Use `Restart=on-failure`
with a delay and bounded restart bursts. Keep SIGTERM cancellation and process
group cleanup effective. Use compatible hardening such as
`NoNewPrivileges=true`; do not hide HOME or source stores with blanket sandbox
settings. Confirm all directives work under user systemd 252.

The dashboard runs with `agent`'s permissions. CI gating is not a sandbox: code
merged into the deployment branch will run with access to that account's data.
Protect repository write access and review changes accordingly.

## 3. Pull updates from GitHub, gated by CI

Use a user-systemd oneshot updater and timer. GitHub-hosted runners must not SSH
into the private LAN. No self-hosted Actions runner or webhook listener is needed.

Timer proposal: `OnBootSec=2min`, `OnUnitInactiveSec=5min`, and
`RandomizedDelaySec=30s`. Do not use `Persistent=true` as a catch-up mechanism
for this monotonic timer; that option applies to calendar timers. Run one manual
check during installation. Normal updates follow successful CI within roughly
one polling interval; this is not an immediate push connection.

Updater transaction:

1. Acquire an exclusive lock shared with manual deploy/rollback operations. Exit
   without mutation when paused or another transaction owns the lock. Use bounded
   network and subprocess timeouts, noninteractive Git, and no credential prompts.
   Resolve any recorded pending transaction before considering a same-SHA no-op.
2. Fetch the configured repository's `main` over HTTPS into the dedicated cache.
   Resolve an exact full commit SHA. No-op if already active. Do not deploy other
   branches, PR refs, or an older successful commit when current `main` is failing.
   Reject non-fast-forward branch rewrites for manual review.
3. Query GitHub's workflow-runs endpoint for the specific workflow file:

   ```text
   GET /repos/arthurnunesc/ccusage-dashboard/actions/workflows/ci.yml/runs
       ?branch=main&event=push&head_sha=<sha>
   ```

   Require the latest matching run/attempt to have `status=completed` and
   `conclusion=success`. Validate repository, branch, event, and exact head SHA.
   Inspect the latest run regardless of conclusion: filtering only for success
   can hide a failed or pending rerun. Handle pagination/order deterministically.
   No matching run, pending checks, failed/cancelled checks, malformed responses,
   or GitHub errors mean **do not deploy**. Never fall back to an unchecked pull.
4. Confirm public Actions metadata is readable without credentials during
   preflight. Prefer no token. If repository policy requires authentication,
   stop and request narrowly scoped read-only access; store it separately and
   never pass it to the dashboard or print it. Respect rate-limit headers,
   Retry-After, and network failures without stopping the running dashboard.
5. Stage the exact verified SHA in a temporary task-owned directory. Install
   frozen production dependencies, verify runtime/config/native binary, and
   record SHA plus CI run ID. On failure, remove only owned staging resources;
   leave the current process and release untouched. Treat finished releases as
   immutable. Recheck branch head/CI before switching; defer if they changed.
6. Record a pending transaction before mutation. Atomically replace `current`
   using a temporary symlink and rename on the same filesystem. Restart only
   `ccusage-dashboard.service`. A brief interruption and a cold in-memory cache
   are acceptable; zero-downtime deployment is not required.
7. Check `GET /api/health` at the configured allowed address, confirm the unit's
   running PID/working directory belongs to the selected release, then check
   `GET /api/usage`. Require a valid current schema, no error, and `stale=false`.
   Bound readiness time above the configured scan timeout plus startup margin.
   An empty valid report is acceptable. Liveness alone is not deployment success.
8. On success, record the healthy SHA and previous release atomically. On failed
   startup/readiness, restore the last healthy symlink/runtime and restart it;
   clear that app unit's failure/rate-limit state if needed and verify rollback
   health and usage too. If this is the first install, stop the failed app and
   report failure instead of claiming a rollback exists.
9. Record failed SHAs and do not reinstall/restart them every five minutes. A new
   SHA or explicit operator retry can unblock deployment. If rollback fails,
   pause updates, stop retry loops, and log exact recovery instructions. Recover
   interrupted pending transactions to the last healthy release on the next
   invocation; never assume the new symlink proves success.

Keep active and previous healthy releases and their runtimes. After a successful
transaction, remove only extra validated task-owned releases. Recover marked
interrupted staging trees under the deployment lock; leave unmarked paths alone.
Retain runtimes for explicit maintenance. Check free space before installing;
disk pressure must not evict the
rollback release or touch unrelated data. Do not write report bodies or source
history into deployment logs/state.

Install control scripts and systemd units separately from release source. Normal
automatic updates switch app releases only; they must not silently rewrite their
own running updater, units, or host config. Changes to that control layer need an
explicit maintenance step. Keep its release contract small and documented.

## 4. Implementation packets and checks

These checkboxes track repository implementation, not completed deployment.

- [x] **Application network settings:** update `src/config.js`, `src/server.js`,
  relevant types in `shared/types.d.ts`, `.env.example`, and README. Add config
  tests for invalid settings and explicit LAN opt-in. Add HTTP tests for default
  localhost behavior, configured Host success, foreign Host rejection, missing
  or foreign refresh Origin/header, method restrictions, and response protections.
  Bind integration tests to loopback with isolated ephemeral ports, not `.52`.
- [x] **Runtime pin and control scripts:** add `.bun-version`, adjust
  `.github/workflows/ci.yml`, add focused scripts under `scripts/deploy/` and
  systemd templates under `deploy/systemd/`. Use Python 3 standard-library code
  for updater JSON/transaction handling plus existing Git/systemctl tools; do
  not add a daemon or package dependency just for deployment.
- [x] **Updater tests:** fake GitHub responses, subprocesses, clock, and systemctl;
  use temporary HOME/state/release trees. Cover same-SHA no-op, CI pending/failure,
  mismatched SHA/event, newer failed rerun, pagination, rate limiting, offline
  operation, lock contention, dirty/unowned target refusal, paused updates,
  branch rewrite, install/disk failure, startup/usage failure, rollback failure,
  interruption recovery, failed-SHA suppression, and safe release cleanup.
  Include real local filesystem atomic-switch/recovery tests. Never call the
  real user's systemctl or read production history during these tests.
- [x] **Runbook:** document bootstrap prerequisites, installed paths, deployed
  SHA/CI inspection, pause/resume, explicit retry, manual update, rollback,
  removal, and control-layer maintenance. Manual rollback must pause updates so
  the timer cannot immediately redeploy the rolled-back commit.
- [x] **CI configuration and local checks:** run `bun run check` and `bun run test:e2e` with existing HOME/XDG
  isolation. Add updater tests to the required workflow. Use disposable resources
  and register cleanup before tests. No deployment credentials in CI.

Downloaded runtimes are retained for explicit maintenance rather than swept by
normal updates. Release cleanup removes only validated obsolete releases. The
current control layer accepts only the checksum-reviewed Bun 1.3.11 archive;
future runtime/dependency contract changes require reviewed control maintenance.
Linux runtime publication and actual user-systemd/network behavior still need
approved target-host checks. GitHub CI has not been run for these unpublished edits.

## 5. Approval and rollout sequence

1. Review this plan and approve implementation. No installation follows merely
   from writing the plan. Keep unrelated package/lock/research work separate.
2. Implement locally, review the exact diff, and pass the complete CI gates.
   Obtain approval to publish/merge. Bootstrap only from an exact green `main`
   commit that includes the deployment changes, not today's older remote SHA.
3. Before server changes, confirm the private-network access policy and present
   the exact runtime install, files, units, and any required firewall rule for
   approval. Recheck disk, port, paths, existing unit state, and source locations.
   Back up any existing target file before an approved replacement; fail on
   unexpected ownership or contents. Do not alter T3 or agent configuration.
4. Install the reviewed control scripts and pinned runtime. Stage the first
   release, write private config, reload user systemd, and start only the app.
   Do not enable automatic updates until the following checks pass.
5. Run approved smoke checks against existing server history: health, a successful
   usage scan, browser load, charts/table, refresh, and safe rejection of foreign
   Host/Origin. Compare a small sample with the pinned native report where data
   exists. Record missing/unsupported sources as limitations, not zero usage.
   No model prompts, credential changes, or Mac history copies are needed.
6. From the Mac on LAN, then a device genuinely off-LAN over WireGuard, verify
   `http://192.168.1.52:8766`, usage loading, and refresh. Numeric IP avoids the
   separate hostname issue. Verify no unintended wildcard/public listener or
   router forwarding. Do not assume an SSH-local curl proves remote access.
7. After approval for lifecycle checks, verify app restart and user-manager
   startup behavior without rebooting the whole host or disrupting T3. Use
   isolated staging to prove failure/rollback; do not break the live app as a
   test. A controlled healthy previous-release rollback needs its own approval.
8. Enable the app and update timer after successful initial checks. Exercise one
   real CI-green update on an approved commit; verify SHA, journal, and readiness.
   Confirm the timer is scheduled and a manual duplicate check is a no-op.
9. Record installed paths, active/previous SHA, runtime, units, timer status,
   known accounting gaps, and recovery commands. Verify all task-owned temporary
   processes/files are cleaned up. Installed app/runtime/units are intentionally
   retained; report them, not as disposable test resources.

## Done means

- The native app starts without any Mac history and leaves existing tools/data
  unchanged. Empty existing history is allowed; scan failures are not hidden.
- LAN and real WireGuard clients can load and refresh the dashboard at the target
  URL. Local-only defaults and security regression tests still pass.
- Only exact CI-green `main` commits deploy automatically. Network/CI/install
  failure leaves the healthy app running; activation failure restores it.
- Operators can identify the running SHA, inspect logs, pause updates, roll back,
  and remove this deployment without touching source history or other services.
- No Docker, public SSH, forwarding, report-transfer pipeline, or Mac import was
  introduced. History migration and remaining accounting work stay separate.

## Documentation checked

- [Bun installation](https://bun.sh/docs/installation),
  [production/frozen installs](https://bun.sh/docs/pm/cli/install), and
  [environment loading](https://bun.sh/docs/runtime/environment-variables).
- [setup-bun version-file support](https://github.com/oven-sh/setup-bun).
- [GitHub workflow-runs REST interface](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).
- [systemd 252 timer semantics](https://www.freedesktop.org/software/systemd/man/252/systemd.timer.html).

Recheck commands and compatibility during implementation; these references do
not authorize unpinned runtime upgrades.
