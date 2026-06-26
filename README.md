# Fable Paint - Infinite Canvas

Drawing web app with an infinite canvas, inspired by Magma and built for single-player use.
Architecture: passive input ring buffer -> single frame loop -> mathematical pipeline
(descriptors, not pixels) -> two-path rasterizer with per-frame budget -> sparse CPU
pixel store (256x256 premultiplied RGBA chunks) -> GPU as projector (WebGL, uploading
only dirty tiles, pan/zoom in the vertex shader).

## Start

Use the static server. ES modules do not run from `file://`:

```bash
npm start
```

Then open `http://localhost:8000`.

## Release

The app is shipped as a static site.

```bash
npm ci
npm test
npm run build
```

`npm run build` writes the deployable artifact to `dist/` without Vite or any
bundler. The GitHub Actions workflow in `.github/workflows/deploy.yml` runs
tests, builds `dist/`, and deploys it to GitHub Pages on pushes to `main`.

To enable GitHub Pages, set the repository Pages source to **GitHub Actions**.

## Launch Config

Runtime launch settings live in `config.js`:

- `release`: release label included in feedback and telemetry.
- `feedbackUrl`: the public support/feedback URL.
- `telemetryEndpoint`: optional HTTP endpoint for JSON product events and
  runtime errors. Empty means telemetry is disabled.

Current first-user policy: project saving is manual. Users should press
**Salva in cartella** or export a `.fablepaint` file before closing the browser.

## Controls

| Action | Desktop | Mobile |
|---|---|---|
| Draw | drag with mouse or pen | one finger |
| Pan | Space+drag, middle/right button, Hand tool (H) | two fingers |
| Zoom | mouse wheel | two-finger pinch |
| Undo / Redo | Ctrl+Z / Ctrl+Y | toolbar buttons |
| Brush size | `[` and `]` | slider |
| Brush / Eraser / Hand | B / E / H | toolbar buttons |
| Brush panel | P | gear button |
| Performance console | `` ` `` | console button |
| Reset view | 0 | view button |

## Brush

Size, opacity, softness, stabilization, 0.1%-300% spacing, roundness, angle,
texture scale/angle/depth, scatter, jitter (position, thickness, opacity,
spacing, angle, brightness, saturation), and pressure-to-size/opacity mapping.

**Build up opacity**: ON means every stamp adds opacity inside the stroke.
OFF (wash) keeps the stroke at a uniform opacity even where it crosses itself.
In wash mode, dabs are accumulated in a stroke buffer with `max(alpha)` and
composited onto the layer once on pointer-up.

## Architecture Notes

- **Continuous path**: with spacing below 5%, no jitter, and a round dab, the
  union of dabs is geometrically a chain of capsules. Work scales with covered
  area, not stamp count: a 5,000-stamp flick becomes roughly 450k pixels.
- **Adaptive raster budget**: at most N touched megapixels per frame (target
  around 6 ms). Excess work stays queued and the stroke catches up with the
  pointer.
- **Low-spacing buildup**: raster spacing is clamped to 3%, and dab alpha is
  compensated with `1-(1-a)^k`: same accumulated coverage with up to 30x less
  work.
- **Tile-diff undo**: "before" chunks are compressed with deflate in a worker,
  outside the pointer path. Limit: 64 steps / 256 MB equivalent.
- **WebGL context loss**: the document lives on the CPU, so textures can be
  recreated.
- **Canvas2D fallback** behind the same renderer interface.

## Structure

```text
js/main.js         single frame loop (input -> sample -> raster -> upload -> present)
js/input.js        coalesced pointer events -> ring buffer; touch gestures
js/stroke.js       smoother, spacing sampler, dynamics -> descriptors
js/brush.js        settings + StampCache (AA masks by bucket, LRU)
js/raster.js       capsules + stamps, budget, stroke-buffer commit
js/store.js        sparse 256² premultiplied chunk store + dirty tracking
js/renderer_gl.js  WebGL: per-chunk textures, procedural grid
js/renderer_2d.js  Canvas2D fallback
js/undo.js+worker  tile-diff undo with worker compression
js/ui.js           brush panel, toolbar, PNG export
```
