# Third-party components

NestForge Pro's own code is under `src/`. These are other people's work, and they keep their own
licences.

## Bundled in this repository

All three live in `vendor/clipper.js`, with their original copyright notices intact at the top of
the file.

| Component | Version | Author | Licence |
|---|---|---|---|
| Clipper, polygon clipping and offsetting | 6.4.2 | Angus Johnson | Boost Software License 1.0, http://www.boost.org/LICENSE_1_0.txt |
| JavaScript translation of Clipper | 6.4.2.2 | Timo | Boost Software License 1.0 |
| JSBN, the big-integer library Clipper uses for exact arithmetic | | Tom Wu | BSD-style, http://www-cs-students.stanford.edu/~tjw/jsbn/LICENSE |

## Loaded from a CDN at runtime

Not stored in this repository. They are fetched from cdnjs when the app starts, and are needed only
for the Excel, PDF and ZIP features.

| Component | Version | Licence |
|---|---|---|
| JSZip | 3.10.1 | MIT or GPLv3 |
| ExcelJS | 4.3.0 | MIT |
| jsPDF | 2.5.1 | MIT |
