# NestForge Pro

A DXF nesting optimiser for leather and sheet cutting, built for footwear production.

Open `index.html` in a browser. There is no build step, no server and no dependencies — the whole
application is a single self-contained file.

## What it does

Nesting is the problem of fitting cut pieces onto a hide or sheet with as little waste as possible.
On a real cutting floor that waste is the single biggest material cost, and leather makes it harder
than sheet metal because the material is irregular, has a grain direction, and has defects you must
cut around.

- **Imports DXF, SVG and images.** Pattern pieces come out of whatever CAD the pattern master used.
- **Nests with grain and mirror constraints.** Left and right pieces flip; a vamp cut across the
  grain is a rejected shoe.
- **Zones.** Mark regions of the hide so pieces are kept off defects and off the belly.
- **Costing, per piece or per pair.** Enter brand, article, component and material, and the sheet
  tells you what the cut actually costs.
- **Export with traceability.** Sheets are stamped with order number and operator, so a cut sheet
  on the floor can be traced back to the job.

## Why it exists

I spent four and a half years in footwear manufacturing, first at Redtape and now at KNS Shoetech.
Cutting rooms nest by hand or pay for software priced for European plants. This is the tool I
wanted on the floor.

## Status

Working and usable. Built as a single file deliberately so it can be dropped onto any machine in a
factory without an install, an account or a network connection.

## Licence

All rights reserved. Readable here as a portfolio piece, not licensed for reuse or redistribution.
