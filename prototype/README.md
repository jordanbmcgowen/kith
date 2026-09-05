# Prototype

`index.html` is the interactive design reference. Open it directly in a
browser, or serve the folder with `npx serve prototype`.

It is a single self-contained file with no build step and no dependencies
beyond three Google Fonts. Treat it as the source of truth for the visual
system: palette, type scale, spacing, motion, and the shape of every screen.

## The part to copy carefully

Everything the prototype displays comes from one fenced block marked
`DEMO DATA`. No view function touches it. Views call an async `store`, and a
single constant picks between `demoStore` and `liveStore`:

```js
const DATA_SOURCE = "demo";   // "demo" | "live"
```

Keep this seam when porting to React. The rules are in `CLAUDE.md` under
"Demo data: the seam". The one that matters most: **the live store never falls
back to demo data on error.** It throws, and the view renders an empty state.
