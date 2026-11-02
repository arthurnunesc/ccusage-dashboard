# ccusage Phase A validation

Checked 2026-11-02. Phase A upgrades the upstream dependency only. It adds no
dashboard log reader or decompression workaround.

## Exact release

The dashboard pins **20.0.33**, the first release with
[PR #1890](https://github.com/ccusage/ccusage/pull/1890). The installed wrapper
and native executable both report this version. The lockfile pins the matching
optional native packages for all supported platforms.

The [release list](https://github.com/ccusage/ccusage/releases) currently ends at
20.0.47, published 2026-11-01. We chose the smallest upgrade with the fix:

- 20.0.32: Nix schema-generation concurrency and an OpenCode fallback-cost
  floating-point tolerance fix.
- 20.0.33: discovery and streaming reads of Codex `.jsonl.zst` rollouts, with
  plain/compressed and active/archive duplicate prevention.
- 20.0.34–20.0.47: additional model mappings, stored-cost JSON fields,
  Claude/Codex deduplication, pricing, unified-report configuration and
  accounting fixes, plus build changes. These are not needed for this fix and
  remain outside this minimal upgrade.

Primary comparisons:
[20.0.31 → 20.0.33](https://github.com/ccusage/ccusage/compare/v20.0.31...v20.0.33)
and [20.0.33 → 20.0.47](https://github.com/ccusage/ccusage/compare/v20.0.33...v20.0.47).
See also the unchanged [background research](research/ccusage-compressed-codex.md).

## Automated compatibility coverage

`tests/contract/ccusage.test.js` runs the real installed native executable with
the dashboard's `daily --by-agent --json` runner. The synthetic Codex fixture
is compressed at test time with `Bun.zstdCompressSync`.

- Plain and compressed inputs produce equal full upstream reports and equal
  normalized snapshots. The fixture has a nonzero known total of 120 tokens.
- The same rollout in both encodings contributes 120 tokens, not 240.
- Distinct compressed active and archived rollouts contribute 240 tokens.
  Adding a duplicate across active/archive paths does not change the report;
  both cross-encoding directions are checked.
- Existing synthetic Claude and empty-source contracts still pass.

The test wrapper supplies a disposable HOME, XDG directories and temporary
directory, with an allowlisted environment. Source roots are synthetic, pricing
is offline, and no real credentials or usage stores are passed to the native
contract tests. Cleanup handlers are registered before temporary-tree creation.

Validation on Bun 1.3.11 / macOS arm64:

- `bun run check`: typecheck and lint passed; 46 unit tests and 6 native contract
  tests passed.
- `bun run test:e2e`: all 8 browser tests passed.
- `git diff --check`: passed.

## Separate local-history diagnostic

This was a manual, read-only diagnostic, not an automated test. Both versions
read the same explicit local source roots with UTC, ascending order, auto cost
mode, offline pricing, a disposable config/cache/home, and an inclusive
`--until 20261031` cutoff. An old-version repeat produced the same per-tool
totals, avoiding the live-history drift seen in the first uncapped scan.

macOS sandbox rules denied network access and writes outside the owned temporary
tree. The old executable was downloaded into that tree and verified against the
npm package SHA-512 integrity value. No original logs, databases, credentials or
configuration were changed.

Codex usage increased; OpenCode, Pi and Gemini token and cost totals stayed
unchanged. Claude emitted no usage rows in either version. A second diagnostic
used disposable copies of compressed Codex files only, preserving their active
and archived layout. The old release reported zero usage; the upgraded release
reported exactly the token increase seen in the full comparison. An initial
compressed-only attempt failed because its empty Claude root lacked `projects/`;
the corrected disposable layout passed. No private log content was added to the
repository or fixtures. All diagnostic copies, binaries and temporary trees
were removed, and owned child processes exited.

Local totals are time-specific diagnostics, not fixture expectations. The older
76,188,776 versus 917,195,025 measurements remain historical observations.

## Limits

This verifies the required JSON and normalization contracts on this platform;
it does not prove complete accounting for all retained history or all platforms.
The upstream compression fix is Codex-specific. Later upstream fixes are not
included. OpenCode compaction accounting remains a separate Phase B concern;
no Phase B fix, issue or PR was made.
