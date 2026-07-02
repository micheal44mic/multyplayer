# Precision audit - Fable Paint

Scope: controlli di precisione rispetto al pain point Canva: misure, snap, guide, griglie, spacing uniforme, lock/align/distribute.

Evidence:
- `01-home.png`: home/cartella lavori.
- `02-canvas.png`: canvas vuoto.
- `03-move-transform.png`: livello raster con Move/Transform attivo.
- `04-warp-grid.png`: tab Warp con griglia 3x3.

Steps checked:
1. Home and project entry - healthy, but not related to precision. A debug/performance panel is visible in the captured state and covers part of the workspace.
2. Blank canvas - usable drawing workspace. There is a dotted background grid, but no visible grid controls such as size, color, subdivision, or snap-to-grid.
3. Move/Transform on real content - good base. The app shows transform tabs, handles, apply/cancel, and Smart Guides active.
4. Warp grid - good advanced feature. 3x3/4x4/5x5 grid controls are visible and feel more pro than Canva for deformation work.

Confirmed strengths:
- Smart Guides exist and are enabled from the Transform toolbar.
- Move snaps pure raster translation to integer pixels before commit, preserving crispness.
- Smart snap compares object edges/centers against the active canvas and other visible layers.
- Resize snap exists for axis-aligned side handles.
- Warp/Perspective/Puppet are unusually strong for a browser drawing tool.
- Brush Studio already has numeric-ish sliders for size, opacity, softness, stabilization, and spacing.

Main gaps for "precision superior to Canva":
- No transform inspector: users cannot type X, Y, W, H, scale %, rotation deg, or reset values.
- No visible distance readout while moving/resizing: users do not see "12 px from left", "center aligned", or delta values.
- No layout actions: align left/center/right/top/middle/bottom and distribute horizontal/vertical are not visible.
- No spacing tool: there is no command for equal gaps between selected layers/objects.
- No user grid controls: dotted workspace grid exists, but not as a controllable document/grid system.
- No manual guide system: users cannot drag guides, lock guides, clear guides, or snap to custom guides.
- No object/layer lock for layout precision was evident in the checked UI.
- Transform tabs update visual active state, but `aria-selected` is not updated, so assistive tech can report the wrong selected tab.

Recommended priority:
1. Add a compact Precision Inspector to Move/Transform: X, Y, W, H, angle, lock ratio, reset, copy/paste values. This is the highest-impact gap.
2. Add Align/Distribute actions in the same toolbar: align to canvas, align to selection, distribute by equal spacing.
3. Add Smart Guide labels during drag: center, edge, delta, gap in px. Snap without feedback feels hidden.
4. Add Grid + Guides popover: show grid, grid size, subdivisions, snap to grid, add vertical/horizontal guide, lock/clear guides.
5. Add a "Spacing" command for multiple selected objects/layers, with one numeric gap input.
6. Fix accessibility state for transform tabs by updating `aria-selected` in `_syncOpts()`.

Evidence limits:
- This audit used screenshots plus code inspection, not a full WCAG audit.
- I did not test every mobile breakpoint or keyboard-only transform workflow.
- The debug/performance panel may be from persisted local state, but if users can see it accidentally it should be guarded.
