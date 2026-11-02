# Upstream research: compressed Codex rollouts

_Checked 2026-10-27. This note covers public upstream issues, pull requests,
releases, and Discussions only; it contains no local log data._

## Result

Do **not** open a duplicate upstream issue or PR. Upstream accepted and shipped
Zstandard (`.jsonl.zst`) support shortly after the reported `20.0.31`
regression:

- [Issue #1888](https://github.com/ccusage/ccusage/issues/1888), **closed** as
  completed, was opened on 2026-10-14. It reports that `20.0.31` discovered
  only `.jsonl` and skipped Codex `.jsonl.zst` session and archive files.
- [PR #1890](https://github.com/ccusage/ccusage/pull/1890), **merged** on
  2026-10-14 at 20:40 UTC, fixes #1888. Its merge commit is
  [`44a3aa84`](https://github.com/ccusage/ccusage/commit/44a3aa84e84cbc1afa40dab3f2849e03e9a9b054).
- [Release v20.0.33](https://github.com/ccusage/ccusage/releases/tag/v20.0.33)
  was published on 2026-10-14 at 21:03 UTC and explicitly lists “Read
  Zstandard-compressed rollouts.” It is the first release that contains the
  fix. The parent independently confirmed that the current latest release is
  v20.0.45 (2026-10-26).

Therefore, the observed `20.0.31` undercount matches the already reported
upstream defect. An upgrade to a version at or after `20.0.33`, with the
parent's validation, is the appropriate next action.

## Accepted contract and design decisions

The PR description gives the direct design record:

1. Discover both plain `.jsonl` and Zstandard `.jsonl.zst`; ignore other
   `.zst` files.
2. Stream Zstandard data into the existing parser; do not unpack logs to disk.
3. Keep the plain-path session identity and deduplicate across encodings.
4. When both encodings exist in one directory, use the plain file once; active
   `sessions/` takes precedence over `archived_sessions/` regardless of
   encoding.
5. If encoding changes between discovery and open, try the alternate encoding.

These are not proposals left open for a contributor. They are the merged
behavior documented in [PR #1890](https://github.com/ccusage/ccusage/pull/1890).
The parent separately verified its implementation and its compression parity /
deduplication tests on the current source history.

## Rejection and discussion record

There is no technical rejection of Zstandard support in the located upstream
record. Instead, #1888 was labelled `bug`, `priority:high`, and
`triage:maintainable`; its triage comment says the issue would remain open for
a focused implementation PR ([direct comment](https://github.com/ccusage/ccusage/issues/1888#issuecomment-6168925003)).

The reporter could not create an upstream PR because the repository uses a
collaborator-only PR policy, and an automation workflow failed before it
published a PR ([reporter comment](https://github.com/ccusage/ccusage/issues/1888#issuecomment-6169445071)). That is a contribution-process
block, not a rejection of the feature. A maintainer then opened and merged
#1890, based on the reporter's reference implementation; #1888 was closed by
the maintainer immediately after the merge ([issue timeline](https://github.com/ccusage/ccusage/issues/1888/timeline)).

## Compression terminology

This work is **Zstandard/zstd**, not gzip. The issue, PR title, PR design, and
release all name Zstandard and `.jsonl.zst`. There is no basis here to treat
gzip support as equivalent or as a substitute for the accepted rollout format.

## Bounded negative search

GitHub's repository issue/PR search for the exact term
[`"jsonl.zst"`](https://github.com/search?q=repo%3Accusage%2Fccusage+in%3Atitle%2Cbody+%22jsonl.zst%22&type=issues)
returned only #1888 and #1890 (including closed items) at the check time.
The repository Discussions API listing (47 discussions, one page of up to 100)
contained no discussion specifically about `.jsonl.zst`, Zstandard, or
compressed Codex rollouts. This is bounded evidence, not proof that no
unindexed, deleted, or external discussion exists.

## Scope across other sources

Checked the pinned `20.0.31` source and current upstream source on 2026-10-27:

| Source | File discovery / reading | Same local compression problem? |
| --- | --- | --- |
| Codex | The fix adds a source-specific Zstandard reader. | Confirmed by the earlier differential probe. |
| Claude | Uses the shared walker for plain `.jsonl` files. | No compressed files found in the inspected local projects root. |
| Pi | Explicitly discovers `.jsonl` files. | No compressed files found in the inspected local sessions root. |
| Gemini | Reads JSON and JSONL through its source-specific parsers. | No compressed files found in the inspected local data root. |
| OpenCode | Primarily reads SQLite, with legacy `.json` message fallback. | Not the same compressed-rollout path. |

PR #1890 did **not** add universal decompression. Its shared-helper change adds
a file-path predicate; the shared JSONL walker still selects `.jsonl` only.
Manually compressing another source's files is therefore not covered by the
Codex fix. The local inventory does not prove complete accounting for every
source or every possible custom data directory.

There is a separate OpenCode accounting gap: both the pinned and current
loaders accept only V2 `assistant` records, excluding token-bearing
`compaction` records. This is independent of file compression and should be
investigated separately before any issue or PR.

Source references:

- [Codex Zstandard reader](https://github.com/ccusage/ccusage/blob/main/rust/adapters/codex/src/reader.rs#L8-L62)
- [Shared plain-JSONL walker](https://github.com/ccusage/ccusage/blob/main/rust/adapters/common/src/lib.rs#L14-L23)
- [Claude discovery](https://github.com/ccusage/ccusage/blob/main/rust/adapters/claude/src/paths.rs#L65-L76)
- [Pi discovery](https://github.com/ccusage/ccusage/blob/main/rust/adapters/pi/src/loader.rs#L100-L102)
- [Gemini readers](https://github.com/ccusage/ccusage/blob/main/rust/adapters/gemini/src/loader.rs#L22-L29)
- [OpenCode V2 type filter](https://github.com/ccusage/ccusage/blob/main/rust/adapters/opencode/src/loader.rs#L412-L420)

## Primary sources

- [#1888 — Codex compressed rollouts are skipped after a Codex update](https://github.com/ccusage/ccusage/issues/1888)
- [#1890 — fix(codex): read Zstandard-compressed rollouts](https://github.com/ccusage/ccusage/pull/1890)
- [Merge commit 44a3aa84](https://github.com/ccusage/ccusage/commit/44a3aa84e84cbc1afa40dab3f2849e03e9a9b054)
- [v20.0.33 release](https://github.com/ccusage/ccusage/releases/tag/v20.0.33)
