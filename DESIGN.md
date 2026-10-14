---
name: Coding Agent Usage
description: Compact local usage ledger
colors:
  ground: "#11151b"
  surface: "#191f28"
  surface-hover: "#252f3e"
  rule: "#35404f"
  text: "#e9edf4"
  muted: "#aab6c7"
  accent: "#a5c7f4"
  warning: "#f0cc8c"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  title:
    fontSize: "26px"
    fontWeight: 650
    letterSpacing: "-0.025em"
  metric:
    fontSize: "28px"
    fontWeight: 600
    letterSpacing: "-0.025em"
  label:
    fontSize: "12px"
rounded:
  control: "6px"
  region: "8px"
spacing:
  compact: "12px"
  group: "18px"
  section: "32px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
    height: "36px"
  summary-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.region}"
    padding: "18px 20px"
---

# Design System: Coding Agent Usage

## Overview

**Creative North Star: "Local usage ledger"**

The user brief fixes a restrained dark developer tool. Show data and its limits
without decorative branding. Preserve familiar native controls and clear state.

**Key Characteristics:**
- Compact, readable data with tabular numbers.
- Flat slate regions and consistent rules.
- Names and values accompany chart colors.

## Colors

The neutral scale carries the interface; muted blue marks controls and focus.
Amber marks incomplete estimates and safe errors. Chart colors are identity
hashes from `shared/format.js`, not fixed positional palettes.

**The Identity Rule.** Never use color alone to identify a tool or model.

## Typography

System fonts are a pinned requirement. The title is 26px, sections 18px, body
14px, labels/table data 12px, and summary values 28px. At narrow widths the title
and values become 24px. All numeric data uses tabular figures.

## Layout

The main region is at most 1320px, with 32px side padding. Six cards use three
equal columns, then two below 700px, then one below 300px. Header and section
actions wrap. Chart and table overflow stays inside their own regions. The
table is bounded to 560px in height, with sticky headers.

## Elevation & Depth

Regions use tonal layering and a single border. Only the tooltip uses a shadow:
`0 6px 20px rgb(0 0 0 / 35%)`. No decorative motion is used.

## Shapes

Controls use 6px corners; cards, chart, and table use 8px corners. No pills,
glass panels, gradients, or decorative illustrations.

## Components

- **Controls:** native buttons/select, 36px minimum height, visible blue focus
  outline; selected toggles use `aria-pressed` and a filled slate-blue surface.
- **Cards:** meaningful label, full-value focusable number, contextual divisor
  or entry count, and an explicit known-subtotal note where required.
- **Chart:** SVG geometry, five ticks, chronological UTC labels, exact model
  legend, pointer and focus tooltips. Preserve proportional segment heights.
- **Table:** native table, header buttons with `aria-sort`, exact numeric
  tooltips, unavailable values as dashes rather than fabricated zeroes.
- **Tooltip:** one delegated controller; viewport-bounded, text-only, no pointer
  capture. Hide on Escape, blur, leave, resize, and rerender.

## Do's and Don'ts

- **Do** keep exact model/tool names available and safely rendered as text.
- **Do** retain contrast and keyboard access across refresh and empty states.
- **Don't** style estimates as authoritative bills.
- **Don't** add marketing sections, remote fonts, animation, or new filters.
