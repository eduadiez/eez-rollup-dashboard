# EEZ interface branding

[DESIGN.md](DESIGN.md) is the design specification for the dashboard, monitor,
and visualizer. Shared primitives live in `src/styles/brand/eez.css`; global
controls and semantic status tokens live in `src/styles/global.css`.

The application uses the specification's dark canvas, 42px grid, flat neutral
surfaces, Geist typography, bracketed mono eyebrows, mixed-weight page headings,
and pill controls. Green indicates interaction and execution status. Chain
identity is conveyed by labels, not differently colored card surfaces. Gradients
are limited to primary-action hover states, accent rails, and progress indicators.

Application adaptations:

- Forms and telemetry panels retain their interaction model; they are not wrapped
  in whole-card anchors. They receive the same flat card surface and hover rail.
  Only whole-card links lift on hover.
- Live data and decoded payload panes are runtime output, not source-code excerpts.
  They do not display invented pinned-commit citations.
- Geist and Geist Mono use the existing locally served Google Fonts WOFF2 files,
  covered by the adjacent SIL Open Font License files.
- The design is dark-only. The old theme switch is no longer exposed.
- The live monitor retains its one-second age clock, scrollable 20/100 block
  windows, and subtle sync-row tint. Search supports the `/` keyboard shortcut.
- Reduced motion disables animations and transitions globally. Keyboard focus
  uses the shared green outline. Mobile layouts retain normal document scrolling.
