# EEZ interface branding

[DESIGN.md](DESIGN.md) is the sole visual specification for the dashboard,
monitor, and visualizer. This file documents application adaptations and asset
provenance; it does not define a separate palette, type scale, or component style.
Shared primitives live in `src/styles/brand/eez.css`; global controls and semantic
status tokens live in `src/styles/global.css`.

## Application adaptations

- Forms and telemetry panels use the specified neutral card surface, 16px radius,
  padding, and hover rail, but are not whole-card anchors. Only whole-card links
  lift on hover; interacting with a form must not move it.
- Bridge and cross-chain calls are separate workflows arranged in 40/60 columns,
  stacked on smaller screens. Each workflow may have its own primary action.
  Proxy selection and call preparation are sections of one card, not nested cards.
- Form values use reading typography; field labels, navigation, filters, badges,
  and actions use mono chrome. Form submit buttons retain a 44px minimum height.
- Live data and decoded payload panes are runtime output, not source excerpts.
  They do not display invented pinned-commit citations.
- Success, warning, and error colors convey state. Network identity uses names
  and logos; it does not change card surfaces or assign category gradients.
- Geist and Geist Mono use locally served WOFF2 files covered by the adjacent
  SIL Open Font License files. The interface is dark-only.
- Reduced motion disables animation and transitions globally. Keyboard focus
  uses the shared green outline. Mobile layouts use normal document scrolling.

## Network assets

Ethereum uses the canonical grayscale diamond; EEZ uses the existing local mark.
Chiado and Gnosis use the unmodified owl mark from the official
[Gnosis media kit](https://github.com/gnosischain/media-kit/blob/dba66ce30b52f44793cc1d546e1955dcabce3bd6/Logos/Owl_Logo%20-%20Mark.svg).
Other deployments can provide an L1 name and logo through runtime configuration;
unknown chains use a neutral network icon.
