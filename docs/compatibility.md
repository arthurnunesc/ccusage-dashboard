# Compatibility and data contract

Runtime: **ccusage 20.0.31**, source commit
`57afdc255fcbe031b0ecd7cac487f8fd7c5d531f` (`v20.0.31`). This is a
**thin wrapper with limited parity**, not an identical replacement pricing engine.

## Approved parity checklist

| Existing feature | Implementation / approved difference | Test reference |
| --- | --- | --- |
| Generated timestamp | Last successful generation, local display, UTC groups | snapshot, server, dashboard |
| All-Time Cost | Authoritative selected-tool cost; partial warning | report, normalize |
| Typical 30d Cost | Inclusive observed calendar-span projection | report |
| 30d Avg Cost/Day | Today/prior 29 UTC dates, active-day divisor ≥1 | report |
| All-Time Tokens | Authoritative selected totals, residual once | normalize, report |
| Typical 30d Tokens | Same lifetime calendar projection | report |
| 30d Avg Tokens/Day | Same active-day basis | report |
| Context labels and exact values | Months/model entries/span/active days, focus/hover values | dashboard, format |
| Monthly chart | UTC chronological stacks, tool + exact model, legend, overflow | report, dashboard |
| Token / dollar toggle | Tokens default; table state unchanged | dashboard |
| Stable model colors | Identity hash, names also shown | format, dashboard |
| Segment tooltips | Pointer/focus, Escape/blur/leave/resize/rerender reset | dashboard |
| All time / per month | Tool/model or tool/month/model grouping | report, dashboard |
| Sort headers | Price descending default, reverse same/new descending, stable ties | report, dashboard |
| Input/Output/Cache Rd/Cache Wr/Total/Price | Exported categories and cost | normalize, dashboard |
| Calls and Reasoning | —; Not provided by ccusage | report, dashboard |
| Pricing source | ccusage auto: recorded or estimated; partial/unattributed | dashboard |
| Top-three ranking and cost/million | Derived view-model and API metrics | report, server |
| 30-day totals/daily/busiest/active days | Derived, injectable UTC clock | report |
| Loading/empty/errors | Explicit states, retry/stale warning | dashboard, snapshot |
| Responsive table/chart | Bounded horizontal regions, sticky table head | dashboard |
| Provider/model separation | Tool/model instead; no inferred providers | report |
| Recorded/CommandCode/models.json precedence | ccusage auto mode; old dollars may differ | contract, normalize |

Test names refer to `tests/unit/<name>.test.js`, `tests/contract/ccusage.test.js`
for contract, and `tests/e2e/dashboard.spec.js` for dashboard.

## Schema version 1

`GET /api/usage` returns:

```text
schemaVersion: 1
generatedAt: ISO generation timestamp of last successful scan
stale: boolean
warnings: safe strings
metadata: ccusage version, offline/auto mode, limitations
days: ordered daily tool summaries
metrics: all-tools pure view-model, calculated with current UTC date
```

A day has `date`, `agent`, `inputTokens`, `outputTokens`, `cacheWriteTokens`,
`cacheReadTokens`, `totalTokens`, `costUsd`, and `models`.
Model entries preserve the exact `model` label and have the same numeric
categories, `missingPricing`, and `attribution` (`model` or `unattributed`).
Synthetic residuals can have `otherTokens`. Unknown input fields are ignored;
required field changes cause a safe compatibility error.

Nested agent totals are authoritative. Top-level day and grand totals are
validated but never added again. Safe-integer nonnegative tokens and finite
nonnegative money are required, including accumulated totals. Duplicate
date/tool records are rejected. Money tolerance is only float rounding, not
permission to hide missing costs.

Exported model categories can omit upstream extra-total tokens. Nonnegative
category/cost/extra-token residuals become **Unattributed usage**, included
once in the table, chart, and ranking. `otherTokens` is **not reasoning**.
Material model totals above authoritative tool totals are incompatible. Tiny
cost residuals are ignored in model display; cards retain authoritative costs.

## Unavailable and partial values

Unified JSON does not expose reliable provider, calls, per-model reasoning,
precise event timestamps, or row-level recorded/estimated provenance.
Unavailable view-model fields are `null`, never fabricated zeroes. Model names
and tool names are not provider evidence. Cache categories are already normalized
by ccusage; reasoning is not added to output again.

`missingPricing` remains separate from the numeric cost. Zero with that flag
means **Unavailable**, not free. A positive flagged cost is a known subtotal,
marked partial. Summary cards disclose incomplete pricing. An absent flag does
not establish an invoice or current prices.

## Calculation differences

For selected history:

```text
observedCalendarDays = max(1, (latestUTCDate - earliestUTCDate) / 86400000 + 1)
typical30d = allTime / observedCalendarDays * 30
recentAverage = recent30dTotal / max(1, activeRecentDates)
costPerMillion = recentCost / recentTokens * 1000000 (zero if no tokens)
```

The rolling window is today's UTC date and its 29 predecessors, not the last
30 historical records; future dates are excluded. Empty selected history gives
six unavailable cards. Historical-only usage gives zero recent averages.
Busiest-day token ties choose the earliest UTC date. Ranking ties use exact
tool/model identifiers. Display rounding never changes underlying money.

ccusage auto mode replaces the old pricing precedence. No promise is made that
old dollar values match. Local log retention and UTC calendar summaries cannot
reproduce precise event-based lifetime averages or authoritative account billing.
