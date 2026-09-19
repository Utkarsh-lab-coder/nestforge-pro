# Generates the sample DXF parts in this folder. Each one is hard for a nester
# in a different way, and each exercises a different part of the DXF parser.
# Units are millimetres, sizes are real footwear components.
#
#   py -3.11 samples/make-samples.py
import math, os

HERE = os.path.dirname(os.path.abspath(__file__))


# ── DXF writing ──────────────────────────────────────────────────────────────
class Dxf:
    def __init__(self):
        self.e = []

    def _f(self, v):
        return ('%.4f' % v).rstrip('0').rstrip('.') if abs(v) > 1e-9 else '0'

    def lwpoly(self, pts, layer, closed=True, bulges=None):
        """pts: [(x, y), ...]; bulges: per-vertex bulge of the segment that
        STARTS at that vertex (tan of a quarter of the arc angle), or None."""
        e = ['0', 'LWPOLYLINE', '8', layer, '90', str(len(pts)), '70', '1' if closed else '0']
        for i, (x, y) in enumerate(pts):
            e += ['10', self._f(x), '20', self._f(y)]
            if bulges and abs(bulges[i]) > 1e-9:
                e += ['42', self._f(bulges[i])]
        self.e += e

    def circle(self, cx, cy, r, layer):
        self.e += ['0', 'CIRCLE', '8', layer, '10', self._f(cx), '20', self._f(cy), '40', self._f(r)]

    def line(self, x1, y1, x2, y2, layer):
        self.e += ['0', 'LINE', '8', layer, '10', self._f(x1), '20', self._f(y1), '11', self._f(x2), '21', self._f(y2)]

    def spline(self, cps, layer, degree=3, closed=True):
        """A clamped B-spline through control points; first == last closes it."""
        n = len(cps)
        m = n + degree + 1                                   # knot count
        inner = m - 2 * (degree + 1)
        knots = [0.0] * (degree + 1) + [(i + 1) / (inner + 1) for i in range(inner)] + [1.0] * (degree + 1)
        e = ['0', 'SPLINE', '8', layer, '70', '1' if closed else '8', '71', str(degree),
             '72', str(m), '73', str(n), '74', '0']
        for k in knots:
            e += ['40', self._f(k)]
        for x, y in cps:
            e += ['10', self._f(x), '20', self._f(y)]
        self.e += e

    def write(self, path):
        head = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
                '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '3',
                '0', 'LAYER', '2', 'BOUNDARY', '70', '0', '62', '7', '6', 'CONTINUOUS',
                '0', 'LAYER', '2', 'STITCH', '70', '0', '62', '1', '6', 'CONTINUOUS',
                '0', 'LAYER', '2', 'HOLES', '70', '0', '62', '5', '6', 'CONTINUOUS',
                '0', 'ENDTAB', '0', 'ENDSEC',
                '0', 'SECTION', '2', 'ENTITIES']
        tail = ['0', 'ENDSEC', '0', 'EOF']
        with open(path, 'w', newline='\r\n') as f:
            f.write('\n'.join(head + self.e + tail) + '\n')


# ── geometry helpers ─────────────────────────────────────────────────────────
def arc_pts(cx, cy, r, a0, a1, n):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def bezier(p0, p1, p2, p3, n):
    out = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        out.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
    return out


def dedupe(pts, tol=0.05):
    out = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > tol:
            out.append(p)
    if math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= tol:
        out.pop()
    return out


# ── 1. vamp with stitch lines and punch holes ───────────────────────────────
def vamp():
    d = Dxf()
    # toe: a wide rounded front; throat: a deep concave notch at the back where the tongue sits
    pts = []
    pts += bezier((0, 40), (0, -10), (60, -8), (95, 0), 40)          # left toe curve
    pts += bezier((95, 0), (130, -8), (190, -10), (190, 40), 40)[1:] # right toe curve
    pts += bezier((190, 40), (192, 90), (178, 115), (150, 128), 30)[1:]  # right side up
    pts += bezier((150, 128), (128, 110), (118, 92), (116, 78), 20)[1:]  # throat notch right
    pts += bezier((116, 78), (105, 70), (85, 70), (74, 78), 16)[1:]      # throat bottom
    pts += bezier((74, 78), (72, 92), (62, 110), (40, 128), 20)[1:]      # throat notch left
    pts += bezier((40, 128), (12, 115), (-2, 90), (0, 40), 30)[1:]       # left side down
    d.lwpoly(dedupe(pts), 'BOUNDARY')
    # two stitch lines following the toe, 6 mm and 12 mm inside the edge
    for off in (6, 12):
        s = bezier((10, 44), (12, off - 3), (60, off - 2), (95, off + 4), 30)
        s += bezier((95, off + 4), (130, off - 2), (178, off - 3), (180, 44), 30)[1:]
        d.lwpoly(s, 'STITCH', closed=False)
    for x in (60, 80, 110, 130):                                          # lace / decorative punch holes
        d.circle(x, 98, 1.6, 'HOLES')
    return d


# ── 2. asymmetric quarter panel ─────────────────────────────────────────────
def quarter():
    d = Dxf()
    pts = [(0, 0)]
    pts += [(x, 0) for x in range(10, 221, 10)]                          # lasting margin, straight
    pts += bezier((220, 0), (232, 30), (228, 70), (206, 92), 24)[1:]     # back curve up
    pts += bezier((206, 92), (190, 102), (170, 108), (150, 104), 16)[1:] # topline to the collar
    pts += bezier((150, 104), (136, 94), (124, 90), (112, 96), 14)[1:]   # collar scoop (concave)
    pts += bezier((112, 96), (96, 112), (70, 118), (44, 106), 20)[1:]    # rise to the front tab
    pts += bezier((44, 106), (28, 96), (12, 60), (0, 0), 30)[1:]         # front edge down, pointed
    d.lwpoly(dedupe(pts), 'BOUNDARY')
    d.line(30, 8, 200, 8, 'STITCH')                                      # lasting allowance line
    return d


# ── 3. crescent heel counter with holes and a slot ──────────────────────────
def heel_counter():
    d = Dxf()
    outer = arc_pts(70, 0, 70, 12, 168, 48)
    inner = arc_pts(70, 0, 34, 168, 12, 30)
    d.lwpoly(dedupe(outer + inner), 'BOUNDARY')
    for a in (50, 90, 130):
        d.circle(70 + 52 * math.cos(math.radians(a)), 52 * math.sin(math.radians(a)), 4, 'HOLES')
    slot = [(55, 44), (85, 44), (85, 50), (55, 50)]
    d.lwpoly(slot, 'HOLES', bulges=[0, 1, 0, 1])                         # rounded-end slot
    return d


# ── 4. eight-point star with rounded tips: deep concavity, interlocks ───────
def star():
    d = Dxf()
    pts, bulges = [], []
    R, r, tip = 60, 34, 7
    for i in range(8):
        a = i * 45
        # two points on the tip, joined by a bulge arc (round tip), then a sharp valley
        pts.append((R * math.cos(math.radians(a - tip)), R * math.sin(math.radians(a - tip)))); bulges.append(math.tan(math.radians(2 * tip) / 4))
        pts.append((R * math.cos(math.radians(a + tip)), R * math.sin(math.radians(a + tip)))); bulges.append(0)
        pts.append((r * math.cos(math.radians(a + 22.5)), r * math.sin(math.radians(a + 22.5)))); bulges.append(0)
    d.lwpoly(pts, 'BOUNDARY', bulges=bulges)
    d.circle(0, 0, 6, 'HOLES')
    return d


# ── 5. tongue as a true B-spline ────────────────────────────────────────────
def tongue():
    d = Dxf()
    cps = [(45, 0), (0, 0), (-8, 40), (0, 90), (8, 130), (30, 152), (45, 150),
           (60, 152), (82, 130), (90, 90), (98, 40), (90, 0), (45, 0)]
    d.spline(cps, 'BOUNDARY')
    d.spline([(45, 20), (20, 60), (45, 100), (70, 60), (45, 20)], 'STITCH')   # foam quilting line
    return d


# ── 6. S-curved eyestay drawn with bulge arcs, six lace holes ───────────────
def eyestay():
    d = Dxf()
    # outline: two long arcs (bulges) and two semicircular ends
    pts = [(0, 0), (150, 14), (150, 44), (0, 30)]
    bulges = [0.18, 1.0, -0.18, 1.0]
    d.lwpoly(pts, 'BOUNDARY', bulges=bulges)
    for i in range(6):
        x = 18 + i * 23
        d.circle(x, 15 + (x / 150) * 14 + 0.0, 2.5, 'HOLES')
    return d


# ── 7. long thin curved welt / binding strip ────────────────────────────────
def welt():
    d = Dxf()
    outer = arc_pts(0, -300, 300, 65, 115, 50)
    inner = arc_pts(0, -300, 288, 115, 65, 50)
    d.lwpoly(dedupe(outer + inner), 'BOUNDARY')
    return d


# ── 8. big wavy mudguard with an internal cut-out, high vertex count ────────
def mudguard():
    d = Dxf()
    # one polar ripple r(t) > 0, then stretched to an ellipse: a polar curve is
    # always a simple closed curve and an affine stretch keeps it that way, so
    # the outline can never cross itself
    pts = []
    for i in range(420):
        t = i / 420 * 2 * math.pi
        r = 1 + 0.12 * math.sin(6 * t) + 0.05 * math.sin(13 * t + 1)
        pts.append((120 + 120 * r * math.cos(t), 80 + 80 * r * math.sin(t)))
    d.lwpoly(pts, 'BOUNDARY')
    win = [(90, 65), (150, 65), (150, 95), (90, 95)]                     # cut-out window, rounded ends
    d.lwpoly(win, 'HOLES', bulges=[0, 1, 0, 1])
    d.line(30, 40, 210, 40, 'STITCH'); d.line(30, 120, 210, 120, 'STITCH')
    return d


PARTS = {
    '01_vamp_stitch_holes.dxf':      vamp,
    '02_quarter_asymmetric.dxf':     quarter,
    '03_heel_counter_crescent.dxf':  heel_counter,
    '04_star_deep_concave.dxf':      star,
    '05_tongue_bspline.dxf':         tongue,
    '06_eyestay_bulge_arcs.dxf':     eyestay,
    '07_welt_thin_curved.dxf':       welt,
    '08_mudguard_wavy_cutout.dxf':   mudguard,
}

for name, fn in PARTS.items():
    fn().write(os.path.join(HERE, name))
    print('wrote', name)
