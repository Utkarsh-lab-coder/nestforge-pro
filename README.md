# NestForge Pro

Leather cutting-room software for footwear production. It nests DXF and SVG pattern pieces onto a
hide or a sheet with as little waste as possible, then works out what the cut actually costs.

To use it, open `dist/nestforge-pro.html` in a browser. It is one self-contained file.

## What it does

**Two nesting engines.**

- **Polygon engine, using no-fit polygons.** Exact geometry. For each piece it computes the Minkowski
  no-fit polygon against every piece already placed, subtracts those from the sheet's inner-fit
  region with Clipper, and takes the best bottom-left position across the allowed rotations. It
  captures true concave interlocking, and the gap between pieces is an exact polygon offset rather
  than a pixel dilation, so precision does not depend on sheet size.
- **Raster engine.** A grid and skyline nester. Faster per placement, and the basis for Cutting Flow.

**Cutting Flow.** Lays pieces out in lanes for a clean CNC cutting path. It runs sixteen complete
layouts, eight angles across horizontal and vertical lanes, and keeps whichever places the most
pieces. With Cutting Flow on it also runs the polygon engine and keeps the better of the two, so
curvy asymmetric parts such as vamps get tight interlock without anyone choosing an engine.

**Rules for leather.**

- Hide quality zones: Butt, Shoulder, Neck, Belly, Fore Flank and Hind Flank. Each component can be
  set to Must, Optional or None for any zone.
- Per component: allowed rotations, mirroring, grain direction, tolerance, or fixed.
- Hide defects, which can be edited or regenerated.
- A guaranteed minimum gap. Both engines are built so rounding can never leave two pieces touching.

**Norm calculator.** Material consumption per piece by the parallelogram method on a 1 cm² grid: net
and gross area, interlock waste, efficiency, and allowance grades from A (5%) to E (25%).

**Costing and reports.** Per piece or per pair, with brand, article, component, material and custom
fields, exported to Excel or PDF. Consolidated reports across several specs.

**Import and export.** Pattern pieces in from DXF (lines, arcs, polyline bulges, B-splines) or SVG,
from individual files, a folder or a ZIP. Custom sheet shapes from DXF, SVG or an image. Export to
DXF, SVG, PDF or ZIP, optionally stamped with the date, the time or custom text such as an order
number. Projects save and reopen as JSON.

## Running it

**As a desktop app (Windows).** Run `desktop\make-shortcut.ps1` once (right-click, Run with
PowerShell). It puts a **NestForge Pro** icon on the desktop and in the Start Menu. Double-click it
and the app opens in its own window with its own icon: no tabs, no address bar, nothing to install.
It uses the Microsoft Edge that is already on every Windows machine as its engine, with a private
profile kept in `desktop\profile` so it never touches your normal browser. The shortcut also tells
Edge not to slow the app down when its window is behind another one, which browsers do by default.
Re-run the script if you move the folder.

**In a browser.** Open `dist/nestforge-pro.html`. It is one file and works with no network at all:
the Excel, PDF and ZIP libraries are bundled inside it.

| File | Use |
|---|---|
| `dist/nestforge-pro.html` | The whole app in one file, fully offline. This is what you give people. |
| `index.html` | The same app loaded straight from `src/`. Open this while developing: edit a file, refresh, no build step. |

## Sample parts

`samples/` holds eight DXF parts to test with, in real footwear sizes. Each is hard for a nester in
a different way and each exercises a different part of the DXF reader:

| File | What it is | What it tests |
|---|---|---|
| `01_vamp_stitch_holes` | Vamp with a deep throat notch | Concave interlock; stitch lines and punch holes on other layers |
| `02_quarter_asymmetric` | Quarter panel | Strong asymmetry, so rotation choice matters |
| `03_heel_counter_crescent` | Crescent heel counter | Crescents nest inside each other; holes and a rounded slot |
| `04_star_deep_concave` | Eight-point star, rounded tips | Extreme concavity; bulge arcs |
| `05_tongue_bspline` | Tongue as a true B-spline | The spline reader (control points and knots) |
| `06_eyestay_bulge_arcs` | S-curved eyestay | Arc-bulge polylines; six lace holes |
| `07_welt_thin_curved` | Long thin curved strip | Thin-part gap enforcement; needs rotation to fit |
| `08_mudguard_wavy_cutout` | Big wavy overlay with a window | 420 vertices; an internal cut-out |

`make-samples.py` regenerates them. In fill mode the engine maximises the number of pieces, so a
layout that skips the large mudguard to fit several small parts wins on count; use component rules
with a set count when every part must appear.

## Building

```
node build.js
```

Reads `index.html`, inlines the stylesheet and every script it references, and writes
`dist/nestforge-pro.html`. It needs Node and nothing else, no packages.

## Structure

```
index.html                  development entry: page markup, and the load order of every script
build.js                    builds dist/nestforge-pro.html
src/
  styles/app.css
  data/hide-data.js         normalised hide outline, zone curves and zone labels
  geometry/
    clipper-shim.js         CLIPPER_SCALE: integer precision of 0.0001 mm
    geo-utils.js            bounding box, area, translate, scale, rotate, mirror, perimeter
    poly-utils.js           PU: polygon helpers and segment intersection
    clipper-global.js       exposes the vendored Clipper as ClipperLib; design notes for the NFP engine
  parser/
    dxf-parser.js           DXF entities, bulges, B-splines, splitting paths at gaps
    svg-parser.js           SVG paths
  nesting/
    engine-workers.js       worker pool: runs deterministic engine jobs in parallel
    flow-strategies.js      the 16-layout Cutting Flow search, shared by both engines
    rasterizer.js           rasterising polygons, gap dilation, skyline column tops
    raster-engine.js        NestEngineRaster: grid and skyline nester, Cutting Flow
    leather.js              LeatherSheet: the hide model
    nfp.js                  no-fit polygons from Minkowski sums
    poly-engine.js          PolyNestEngine: the NFP nester and its optimisation phases
    engine-wrapper.js       NestEngine: chooses the raster or the polygon engine
    leather-norm.js         LeatherNorm: the norm calculator
  render/                   colors.js, renderer.js
  export/                   consolidated-report.js, costing.js, export-manager.js
  import/                   auto-size.js, dxf-import.js
  ui/                       worksheet-manager.js, and app.js (App: the interface and orchestration)
vendor/
  clipper.js                Angus Johnson's Clipper 6.4.2, see THIRD-PARTY.md
  jszip.min.js              bundled export libraries, see THIRD-PARTY.md
  exceljs.min.js
  jspdf.umd.min.js
samples/                    eight test DXF parts and the script that makes them
desktop/
  make-shortcut.ps1         creates the desktop and Start Menu shortcuts
  make-icon.py              regenerates NestForge Pro.ico and the embedded favicon
  NestForge Pro.ico
dist/
  nestforge-pro.html        built output
```

## Adding to it

The modules are plain scripts, not ES modules, and they share one global scope: a module can use
anything declared by a module loaded before it. **The order of the script tags in `index.html` is
the dependency order.**

To add a module, create the file under `src/` and add a `<script src="src/...">` line to
`index.html`, after everything it uses and before anything that uses it. The build picks it up with
no other change.

A script tag carrying `data-inline="append"` is merged by the build into the block above it rather
than starting a new one. It is used only to keep Clipper beside the raster engine, the way the
original single file had it.

## Licence

© Utkarsh. All rights reserved. Readable here as a portfolio piece, not licensed for reuse or
redistribution. Third-party components keep their own licences; see `THIRD-PARTY.md`.
