'use strict';
/*
 * NestForge Pro build
 *
 *   node build.js
 *
 * Reads index.html (the development entry point) and writes
 * dist/nestforge-pro.html: one self-contained file with the stylesheet
 * and every script inlined. That single file is what you hand to people.
 *
 * Rules, driven entirely by index.html:
 *   <link rel="stylesheet" href="X">                -> <style> X </style>
 *   <script src="X"></script>                       -> <script> marker + X </script>
 *   <script src="X" data-inline="append"></script>  -> X appended to the block above it
 *   <script src="https://...">                      -> left as-is (CDN libraries)
 *   anything else                                   -> copied through unchanged
 *
 * Files are read and written as latin1, which maps every byte to itself,
 * so the output is exactly the concatenation of the source bytes and any
 * UTF-8 in the sources passes through untouched.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_FILE = path.join(ROOT, 'dist', 'nestforge-pro.html');

// The "INLINED FROM" marker written above each file, stored as exact bytes.
const PREFIX = Buffer.from('2f2a20e29481e29481e29481e29481e29481e29481e29481e29481e29481e29481e29481e29481e29481e2948120494e4c494e45442046524f4d20', 'hex').toString('latin1');
const SUFFIX = Buffer.from('20e29481e29481e29481e29481e29481e29481e29481e29481e29481e29481e29481e29481e29481e29481202a2f', 'hex').toString('latin1');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'latin1');

function attr(tag, name) {
  const key = name + '="';
  const i = tag.indexOf(key);
  if (i < 0) return null;
  return tag.slice(i + key.length, tag.indexOf('"', i + key.length));
}

const isRemote = (src) => src.startsWith('http://') || src.startsWith('https://');

const lines = read('index.html').split('\n');
if (lines[lines.length - 1] === '') lines.pop();

const out = [];
let open = false;
const closeBlock = () => { if (open) { out.push('</script>\n'); open = false; } };

for (const raw of lines) {
  const cr = raw.endsWith('\r');
  const line = cr ? raw.slice(0, -1) : raw;
  const eol = cr ? '\r\n' : '\n';

  if (line.startsWith('<link rel="stylesheet" href="') && line.endsWith('">')) {
    closeBlock();
    out.push('<style>\n' + read(attr(line, 'href')) + '</style>\n');
    continue;
  }

  const isTag = line.startsWith('<script src="') && line.endsWith('></script>');
  const src = isTag ? attr(line, 'src') : null;
  if (src && !isRemote(src)) {
    if (attr(line, 'data-inline') === 'append') {
      if (!open) throw new Error(src + ': data-inline="append" but no script block is open above it');
      out.push(read(src));
    } else {
      closeBlock();
      out.push('<script>\n' + PREFIX + src + SUFFIX + '\n' + read(src));
      open = true;
    }
    continue;
  }

  closeBlock();
  out.push(line + eol);
}
closeBlock();

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, out.join(''), 'latin1');
console.log('built dist/nestforge-pro.html  (' + (fs.statSync(OUT_FILE).size / 1024).toFixed(1) + ' KB)');
