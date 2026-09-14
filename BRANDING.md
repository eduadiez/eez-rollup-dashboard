# EEZ interface branding

Both the rollup dashboard and the standalone monitor use the brand primitives
in `network-observatory/app/static/brand/eez.css`. The React app imports this
stylesheet and the SVGs directly; Vite bundles them into its production assets.
The monitor serves the same files from its explicit static-file allowlist.

The visual reference is [EEZ demos](https://github.com/0xarmagan/eez-demos),
specifically its [homepage](https://github.com/0xarmagan/eez-demos/blob/main/index.html)
and [walkthrough controls](https://github.com/0xarmagan/eez-demos/blob/main/dapp-developers/q2-send-a-cross-chain-call.html).
The wordmark and favicon are the original SVG artwork from that reference.
The light-theme wordmark changes only the lettering to charcoal.

- Canvas `#0A0A0A`, panels `#161616`, controls `#1F1F1F`, borders `#2E2E2E`.
- A 42px background grid, Geist headings and body text, Geist Mono labels and data.
- Mixed-weight page headings, bracketed eyebrows, 16px cards, and pill controls.
- Green → blue → violet accents (`#8AE5AC`, `#6283BD`, `#4439CB`).
- Distinct colors remain available for execution routes, warnings, and failures.

Geist and Geist Mono are served locally as Latin variable WOFF2 fonts. They
come from Google Fonts and are distributed under the adjacent SIL Open Font
License files. No external font request is required by either application.
System fallbacks cover glyphs outside the Latin subset.

The dashboard starts in dark mode and preserves an explicitly saved theme.
The light palette shares the same typography, geometry, and brand artwork.
Both interfaces respect reduced motion and provide visible keyboard focus.
