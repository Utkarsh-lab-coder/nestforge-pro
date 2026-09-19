# Builds the NestForge Pro icon: desktop/NestForge Pro.ico (all Windows sizes)
# and the small PNG that index.html embeds as its favicon, so the app window
# and taskbar show the same mark. Brand colours from src/styles/app.css.
#
#   py -3.11 desktop/make-icon.py
import base64, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ACCENT, BG = (0xF9, 0x73, 0x16), (0x1A, 0x1D, 0x28)      # --accent, --card


def tile(size):
    s = size * 8                                            # draw big, shrink for clean edges
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s // 5, fill=BG + (255,))
    font = ImageFont.truetype('C:/Windows/Fonts/bahnschrift.ttf', int(s * 0.78))
    box = d.textbbox((0, 0), 'N', font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((s - w) / 2 - box[0], (s - h) / 2 - box[1] - s * 0.02), 'N', font=font, fill=ACCENT + (255,))
    return im.resize((size, size), Image.LANCZOS)


sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
frames = [tile(n) for n in sizes]
ico = os.path.join(HERE, 'NestForge Pro.ico')
frames[-1].save(ico, format='ICO', sizes=[(n, n) for n in sizes], append_images=frames[:-1])
print('wrote', ico, os.path.getsize(ico), 'bytes,', len(sizes), 'sizes')

png = os.path.join(HERE, 'favicon-64.png')
tile(64).save(png, optimize=True)
b64 = base64.b64encode(open(png, 'rb').read()).decode('ascii')
tag = '<link rel="icon" type="image/png" href="data:image/png;base64,%s">' % b64

idx = os.path.join(ROOT, 'index.html')
html = open(idx, 'rb').read().decode('utf-8')
if 'rel="icon"' not in html:
    anchor = '<title>NestForge Pro'
    i = html.index(anchor)
    html = html[:i] + tag + '\n' + html[i:]
    open(idx, 'wb').write(html.encode('utf-8'))
    print('index.html: favicon added (%d chars of base64)' % len(b64))
else:
    print('index.html: favicon already present')
