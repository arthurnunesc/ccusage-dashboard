# ccusage-dashboard

A local web dashboard for coding-agent tokens and cost estimates, powered by
[ccusage](https://github.com/ccusage/ccusage). ccusage reads your retained agent
logs and handles pricing. This project only validates, groups, and displays its
daily JSON. No database, bundler, or build step is required.

## Run locally

Tested with **Bun 1.3.11**. Install [Bun](https://bun.sh), then:

```sh
bun install --frozen-lockfile
bun run start
```

Open **http://127.0.0.1:8766**. The server binds to 127.0.0.1 only. Use
`bun run dev` for development reload. The first report can take time on a large
history. Controls filter the loaded report; they do not start new scans.

## What it shows

- Six lifetime, projected 30-day, and recent active-day summary cards.
- Monthly token/cost stacks by tool and exact model identity.
- Sortable all-time and per-month details, with a tool filter.
- Manual refresh, successful-snapshot caching, and stale-data recovery.

Grouping uses UTC; the generation timestamp uses your browser's local time.
All sources detected by the pinned ccusage release remain displayable, including
unknown tool names and named Pi stores. History covers only data ccusage can
still find on this machine, not deleted logs or other devices.

**Costs are estimates or recorded local calculations, not invoices or
subscription charges.** Missing pricing is marked unavailable or partial.
Calls, reasoning, provider identity, and precise recorded/estimated provenance
are not exported by unified daily JSON. [Compatibility](docs/compatibility.md)
documents these limits and the lifetime approximation.

## Configuration

Bun reads `.env` automatically. Copy `.env.example` if needed. Keep private
source paths in your own ignored configuration, never in committed files.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8766` | Local port, 0–65535; 0 asks the OS for an ephemeral port. |
| `CCUSAGE_CONFIG` | Project `ccusage.config.json` | Resolved config file path. |
| `CCUSAGE_OFFLINE` | `true` | Use cached/bundled pricing without network pricing refresh. Only `true`/`false` accepted. |
| `CCUSAGE_CACHE_TTL_MS` | `60000` | Reload on the next request after this age; no polling. |
| `CCUSAGE_TIMEOUT_MS` | `120000` | Maximum scan duration, at most 2147483647ms (timer limit). |
| `CCUSAGE_MAX_OUTPUT_BYTES` | `67108864` | Maximum buffered report size. |
| `CCUSAGE_BIN` | Unset | One trusted executable path, mainly for tests. Not a shell command. |

Invalid settings fail at startup. The timeout and output size protect the local
process; increase them if your retained history needs more time or memory.
The shipped config contains no personal paths or custom rates. Required daily,
by-agent, JSON, UTC, ascending-order, and auto-cost flags are always passed.

Pricing is **offline by default**. Set `CCUSAGE_OFFLINE=false` to explicitly allow
ccusage's normal pricing refresh. The dashboard does not implement prices.
The runner owns the offline flag; the shipped ccusage config does not force it,
so the online opt-in works. A custom config that sets `offline: true` can still
prevent refresh when that flag is omitted. Remove that setting for online use.
For source-path discovery and native pricing overrides, use the pinned
[ccusage configuration guide](https://github.com/ccusage/ccusage/blob/57afdc255fcbe031b0ecd7cac487f8fd7c5d531f/docs/guide/config-files.md)
and [CLI options](https://github.com/ccusage/ccusage/blob/57afdc255fcbe031b0ecd7cac487f8fd7c5d531f/docs/guide/cli-options.md).
Use `CCUSAGE_CONFIG` to select your own config. Do not add credentials or alter
agent settings for the dashboard.

## Checks and contributions

```sh
bun install --frozen-lockfile
bun run check
bunx --no-install playwright install chromium
bun run test:e2e
```

`check` runs JSDoc type checking, Biome, Bun unit/HTTP/subprocess tests, and the
actual pinned-native contract test. `test:contract` uses an allowlisted child
environment, disposable HOME/XDG/source roots, and synthetic logs. `test:e2e`
uses Playwright's managed server and a fake executable. Tests must never read
real agent data, credentials, or private pricing caches. Test resources are
owned and cleaned up. Browser artifacts are ignored.
The test wrapper uses a disposable HOME/XDG/temp tree and an owned process
group. It removes only that tree and stops owned descendants, including browser
profiles from that run, on success, failure, SIGINT, and SIGTERM.

On Linux, browser installation may need
`bunx --no-install playwright install --with-deps chromium`.
CI pins the tested Bun version, uses the frozen lockfile, and runs both checks.
Keep runtime ccusage pinned at `20.0.31`; deliberate upgrades must rerun the
native contract and review schema/pricing changes.

## Troubleshooting

- **Missing native executable:** reinstall dependencies with optional packages
  enabled. The app never downloads a binary during a browser request.
- **Incompatible report:** run `bun run test:contract`; verify the exact pinned
  dependency and your configuration. No speculative alternate schemas are used.
- **Timeout/output limit:** increase the documented safeguards and retry.
- **No usage:** check ccusage source discovery and retained local logs. Empty
  reports are valid, not errors.
- **Refresh failure:** old data stays visible and is marked stale. The last
  successful generation time does not change. Fix the source/config issue and
  select Refresh.
- **Blocked refresh:** use the direct localhost URL, not a reverse proxy or
  remote hostname. Host and same-origin checks intentionally reject foreign
  requests. No permissive CORS is provided.
- **Package release-age policy blocks the initial install:** the exact required
  versions were installed with `bun install --minimum-release-age 0`. Review
  your package policy before using that explicit exception.

## License

MIT for this project's original code. ccusage remains separately licensed by
its authors; it is used as an installed dependency, not copied or forked.
