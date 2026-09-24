---
version: alpha
name: EEZ Quickstarts
description: Design language of the eez-demos site (index + 17 animated walkthroughs) — pure-black engineering aesthetic built on the eez.io brand.
omitted:
  - section: spacing
    reason: "No named spacing scale in source; layout dimensions are documented in the Layout section."
  - section: rounded
    reason: "No named radius token in source; radii are per-component, recorded in Components."
colors:
  primary: "#3BE57E"
  eez-green: "#3BE57E"
  canvas: "#0A0A0A"
  screen: "#161616"
  chrome: "#1F1F1F"
  edge: "#2E2E2E"
  muted: "#9aa3b3"
  label: "#9ba6d6"
  foreground: "#ffffff"
  ink-on-grad: "#0A0A0A"
  grad-start: "#8AE5AC"
  grad-mid: "#6283BD"
  grad-end: "#4439CB"
  logo-grad-start: "#8ce8ab"
  logo-grad-end: "#3f2acd"
  pinned: "#A8F3CE"
typography:
  sans:
    fontFamily: Geist
  mono:
    fontFamily: Geist Mono
  display:
    fontFamily: Geist
    fontSize: 48px
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: -0.01em
  lede:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.55
  eyebrow:
    fontFamily: Geist Mono
    fontSize: 12.5px
    fontWeight: 400
    letterSpacing: 0.1em
  card-title:
    fontFamily: Geist
    fontSize: 17.5px
    fontWeight: 600
    lineHeight: 1.35
  card-hook:
    fontFamily: Geist
    fontSize: 13.5px
    fontWeight: 400
    lineHeight: 1.55
  badge:
    fontFamily: Geist Mono
    fontSize: 11px
    fontWeight: 400
    letterSpacing: 0.04em
  cta:
    fontFamily: Geist Mono
    fontSize: 11.5px
    fontWeight: 500
    letterSpacing: 0.02em
components:
  card:
    backgroundColor: "{colors.screen}"
    textColor: "{colors.foreground}"
    rounded: 16px
    padding: 28px 26px 26px
  pill:
    backgroundColor: "{colors.foreground}"
    textColor: "#000000"
    typography: "{typography.cta}"
    rounded: 100px
    padding: 5px 5px 5px 20px
  terminal:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.foreground}"
    typography: "{typography.mono}"
    rounded: 10px
  search-input:
    backgroundColor: "#090909"
    textColor: "{colors.foreground}"
    rounded: 12px
    padding: 13px 44px 13px 42px
  filter-tab:
    backgroundColor: "#0d0d0d"
    textColor: "#888888"
    rounded: 100px
    padding: 6px 14px
  badge:
    textColor: "{colors.muted}"
    typography: "{typography.badge}"
    rounded: 100px
    padding: 3px 9px
  action-chip:
    backgroundColor: "#1a1a1a"
    textColor: "{colors.muted}"
    rounded: 5px
    padding: 3px 8px
  gradient-button:
    textColor: "{colors.ink-on-grad}"
    rounded: 100px
---

# EEZ Quickstarts — DESIGN.md

## Overview

EEZ Quickstarts is a static, no-build explainer site: an index of 17 cards, each linking to a short animated walkthrough of one EEZ protocol mechanic, backed by real cited source code. The design language is the eez.io brand rebuilt for a documentation surface: a pure black canvas with a faint grid texture, Geist and Geist Mono type, mixed-weight headline splits, bracket-wrapped mono eyebrows (`[ LABEL ]`), pill CTAs with a trailing circle-arrow, and flat monochrome cards where the brand's green→blue→purple gradient is reserved exclusively for hover states and thin accent rails — never used as per-category branding. The overall feel is a dark engineering terminal: quiet, dense, monospaced chrome around sans-serif content, with color earned rather than decorative.

## Colors

The palette is monochrome-first: five neutral surface steps plus one green accent (`primary`, aliased as `eez-green` after the source token), with the brand gradient as the only polychrome element.

- **Canvas (`canvas`, #0A0A0A):** the page ground, always overlaid with a faint 42px grid texture drawn from two 1px `rgba(255,255,255,.045)` line layers. The raw `html/body` behind it is #000.
- **Screen (`screen`, #161616):** raised content surfaces — card bodies and terminal code panes.
- **Chrome (`chrome`, #1F1F1F):** window furniture — terminal headers and toolbars.
- **Edge (`edge`, #2E2E2E):** the single hairline border color for cards, terminals, chips, and dividers. Even quieter hairlines (#1a1a1a) separate page-level regions like the footer and stage header.
- **Muted (`muted`, #9aa3b3):** secondary text — eyebrows, CTAs, badges, citations, step labels.
- **EEZ green (`eez-green`, #3BE57E):** the functional accent — focus rings, search focus, active diagram strokes, and intro-slide eyebrows. Never a fill for large areas.
- **Brand gradient (`grad-start` → `grad-mid` → `grad-end`):** #8AE5AC → #6283BD → #4439CB at 90deg (stops 0% / 55% / 100%) for accent rails and progress bars; the two-stop variant (#8AE5AC → #6283BD) fills primary gradient buttons with near-black (`ink-on-grad`) text. The logo's vertical gradient (`logo-grad-start` → `logo-grad-end`) paints card hover rails.
- **Pinned (`pinned`, #A8F3CE):** a paler green reserved for the "PINNED" commit marker in terminal headers.
- **Label (`label`, #9ba6d6):** a cool periwinkle for diagram labels inside walkthroughs.

Text hierarchy runs #fff (headings, hover states) → #dcdcdc (the light half of headline splits) → #c9cfda (ledes) → muted → #8f8f8f (card hooks) → #4d4d4d (quiet card numbers).

## Typography

Geist carries all reading content; Geist Mono carries all chrome. Both load from Google Fonts (Geist 400–800, Geist Mono 400–600), with `system-ui` and `ui-monospace`/`SF Mono`/`Menlo` fallback stacks.

- **Display:** the h1 is a mixed-weight split — alternating spans of weight 800 white and weight 300 #dcdcdc — at 48px / 1.08 / -0.01em, dropping to 32px under 640px. Use `text-wrap: balance`.
- **Eyebrows:** every section label is mono, 12.5px, letter-spaced 0.1em, muted, and wrapped in literal brackets: `[ DAPP DEVELOPERS ]`. Eyebrows double as h2s with UA heading defaults neutralized.
- **Ledes:** 18px / 1.55 in #c9cfda, max-width 640px, `text-wrap: pretty`.
- **Mono-as-chrome:** nav links, CTAs, badges, filter tabs, keyboard-shortcut hints, footer labels, and citations are all mono at 11–13px with slight positive tracking (0.02–0.08em), usually uppercase.
- Card titles and hooks follow the `card-title` and `card-hook` scales; hooks may embed inline `code`.

## Layout

- The index wraps content at max-width 1200px with 48px top / 32px side padding (32px / 18px under 640px) and a 100px bottom reserve.
- Card grids use `repeat(auto-fit, minmax(300px, 1fr))` with 16px gaps; sections with exactly four cards use a fixed 2-column variant that collapses to one column under 700px (an even 4 never divides into 3 columns without a phantom cell).
- Section rhythm: 56px above each section head, 18px between eyebrow and grid.
- Walkthrough pages are authored as a fixed 1920×1080 stage, scaled to fit the viewport and never scrolled; below 1120px the stage reflows into a normal stacked document (`!important` overrides on the stage children, flex rows forced to wrap, code panes capped at 60vh).
- The stage header is a 96px bar with a 3px gradient progress bar along its bottom edge, holding the back link, title, PRE-MAINNET tag, step label, and NEXT link.

## Elevation & Depth

Surfaces are flat by default — depth is stated by the surface-step colors and hairline borders, not shadows. Only two effects exist:

- **Card hover:** lift `translateY(-4px)`, shadow `0 20px 44px -20px rgba(0,0,0,.75)`, background deepens to #0d0d0d, border to #333, and a 2px gradient rail fades in along the top edge.
- **Search focus:** green border plus a soft `0 0 0 3px rgba(63,185,80,0.15)` ring.

The 2px gradient top rail is the site's signature accent: cards show it on hover, terminal windows show it permanently.

## Shapes

- Cards: 16px radius. Search input: 12px. Terminal windows: 10px. Small action chips and shortcut hints: 4–5px.
- Anything pill-shaped — CTAs, badges, filter tabs, gradient buttons — uses 100px (fully rounded).
- Arrow affordances are perfect circles (26–30px) containing a `→` glyph; on hover the circle nudges `translateX(2–3px)` and, inside cards, fills with the gradient.
- The pinned-commit marker is an 8px square rotated 45° (a diamond).
- Focus visibility is a 2px solid green outline offset 2px, applied to links, cards, and buttons alike.

## Components

- **Card:** the whole card is one anchor. Contents: a head row (quiet mono number + title, optional pill badge right-aligned), a hook paragraph, and a bottom-pinned mono CTA row ("WATCH THE 3-STEP WALKTHROUGH" + circle-arrow). Visited cards dim their title to #b8b8b8. Cards carry no code snippets.
- **Pill CTA:** white pill, black mono text, trailing 30px dark circle-arrow; the outline variant is transparent with an edge border. Exactly one solid pill per row — the primary action; all siblings are outline.
- **Terminal window:** chrome header (pinned diamond + commit-pinned `file:line` citation link in muted mono with a dotted underline + uppercase action chips: FULL / TEST / COPY) over a screen-colored code pane with line numbers and a blinking cursor, set in mono at 19px / 34px at the 1920px authoring scale. Permanent gradient top rail; body and header divided by edge-colored hairlines.
- **Search + filters:** full-width dark input with leading search icon and a trailing `/` shortcut hint; mono uppercase filter pills below, where the active tab inverts to white-on-black-text. An empty state uses a dashed edge border.
- **Nav / footer:** mono 12px links in #9a9a9a brightening to white on hover; footer separated by a #1a1a1a hairline with an uppercase letter-spaced label.
- **Motion:** transitions are 0.2s ease across the board (0.15s for text color). Walkthroughs add `riseIn` (12px rise + fade, 0.4s), `dashMove` (marching-ants SVG connectors), and a blinking cursor; `prefers-reduced-motion: reduce` neutralizes all animation and transitions globally.

## Do's and Don'ts

- **Do** reserve the gradient for hover states, thin accent rails, progress bars, and the primary button — never as per-category branding or large fills.
- **Do** cite a real, pinned-commit `file:line` on every code panel; nothing paraphrased or invented.
- **Do** keep every interactive element reachable with the shared green focus ring.
- **Don't** color-code sections or cards by category (the rejected "colored rail per category" pattern).
- **Don't** put code snippets on index cards; the card sells the walkthrough with a title, hook, and CTA only.
- **Don't** use IBM Plex — it was explicitly replaced by Geist in the brand redesign.
- **Don't** let the quiet card number be the sole conveyor of order; it is intentionally redundant with card position.
