/* Generates the Plotline logo, app icons and Play feature graphic.
 *
 * The mark is a plot line: a four-point trend line whose final point is
 * highlighted in the app's teal accent — the "finding" the app exists to
 * surface. It replaces the old CountWhen "C", which named a brand that no
 * longer exists.
 *
 * Rendering goes through Chrome (already a dependency for screenshots.js)
 * rather than an SVG rasteriser, so the output matches what a browser shows
 * and needs no extra native tooling.
 *
 *   npm run logo    -> writes icons/*.png, store/icon-512.png,
 *                      store/feature-graphic.png, icons/logo.svg
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const ICONS = path.join(ROOT, 'icons');
const STORE = path.join(ROOT, 'store');

const BRAND = '#ff7a2f';
const BRAND_LIGHT = '#ffa25e';
const TEAL = '#12b3a6';
const INK_TOP = '#232b4a';
const INK_BOT = '#0d1120';

/* The mark, drawn in a 512 box. `scale` shrinks the artwork toward the
 * centre; maskable icons need it because launchers crop to a circle that
 * only guarantees the middle 80%.
 *
 * The artwork's visual centre is not the box centre — the dots have unequal
 * radii, so the drawn extent runs x 78..456, y 104..370. Everything is
 * therefore positioned about that measured centre rather than about the
 * path coordinates, or the mark sits high and to the right. */
const ART_CX = 267;
const ART_CY = 237;
const ART_REACH = 221;   // furthest drawn pixel from the artwork centre

function mark({ scale = 0.9, radius = 112, bleed = false } = {}) {
  const pts = [
    [104, 344],
    [206, 250],
    [304, 296],
    [410, 150],
  ];
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  const dots = pts
    .map(([x, y], i) => {
      const last = i === pts.length - 1;
      return last
        ? `<circle cx="${x}" cy="${y}" r="46" fill="${TEAL}"/>
           <circle cx="${x}" cy="${y}" r="21" fill="#ffffff"/>`
        : `<circle cx="${x}" cy="${y}" r="26" fill="#ffffff"/>`;
    })
    .join('\n');

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${INK_TOP}"/>
      <stop offset="1" stop-color="${INK_BOT}"/>
    </linearGradient>
    <linearGradient id="line" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="${BRAND}"/>
      <stop offset="1" stop-color="${BRAND_LIGHT}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="${bleed ? 0 : radius}" fill="url(#bg)"/>
  <g transform="translate(256,256) scale(${scale}) translate(${-ART_CX},${-ART_CY})">
    <path d="${d}" fill="none" stroke="url(#line)" stroke-width="38"
          stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  </g>
</svg>`.trim();
}

function featureGraphic() {
  /* 1024x500, Play's required feature-graphic size. Safe to centre text:
     Play crops the edges on some surfaces. */
  const logo = mark({ radius: 44 })
    .replace(/^<svg[^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="230" height="230">');
  return `
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  .wrap{
    width:1024px;height:500px;display:flex;align-items:center;gap:46px;
    padding:0 76px;box-sizing:border-box;
    background:radial-gradient(120% 140% at 8% 12%, #2b3459 0%, ${INK_BOT} 62%);
    font-family:-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;
  }
  .txt{color:#fff}
  h1{margin:0;font-size:78px;letter-spacing:-2.2px;font-weight:700;line-height:1}
  p{margin:16px 0 0;font-size:29px;color:#aeb8d8;font-weight:400;letter-spacing:-.2px}
  .rule{width:64px;height:5px;border-radius:3px;background:${BRAND};margin:24px 0 0}
</style></head><body>
  <div class="wrap">
    ${logo}
    <div class="txt">
      <h1>Plotline</h1>
      <p>Log what happens. Find what matters.</p>
      <div class="rule"></div>
    </div>
  </div>
</body></html>`.trim();
}

async function shoot(page, html, w, h, out) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: out, omitBackground: false });
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`  wrote ${path.relative(ROOT, out)}  ${w}x${h}  ${kb} KB`);
}

const wrapSvg = (svg, w, h) => `
<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden}
svg{display:block;width:${w}px;height:${h}px}
</style></head><body>${svg}</body></html>`.trim();

/* Browsers request /favicon.ico by default, and Chrome caches favicons far
 * more aggressively than ordinary images — a <link> change alone will not
 * dislodge one it has already stored for an origin. Shipping a real .ico at
 * the conventional path, alongside version-stamped <link> URLs, is what
 * actually forces a refresh.
 *
 * ICO is a directory of images; embedding PNGs is supported by every browser
 * in use. Header is 6 bytes, then one 16-byte entry per image, then the data.
 * A stored dimension of 0 means 256. */
function writeIco(entries, out) {
  const imgs = entries.map((e) => ({ size: e.size, buf: fs.readFileSync(e.path) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type: icon
  header.writeUInt16LE(imgs.length, 4);
  const dir = Buffer.alloc(16 * imgs.length);
  let offset = header.length + dir.length;
  imgs.forEach((im, i) => {
    const o = i * 16;
    const dim = im.size >= 256 ? 0 : im.size;
    dir.writeUInt8(dim, o);            // width
    dir.writeUInt8(dim, o + 1);        // height
    dir.writeUInt8(0, o + 2);          // palette size (0 = truecolour)
    dir.writeUInt8(0, o + 3);          // reserved
    dir.writeUInt16LE(1, o + 4);       // colour planes
    dir.writeUInt16LE(32, o + 6);      // bits per pixel
    dir.writeUInt32LE(im.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += im.buf.length;
  });
  fs.writeFileSync(out, Buffer.concat([header, dir, ...imgs.map((i) => i.buf)]));
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`  wrote ${path.relative(ROOT, out)}  ${imgs.map((i) => i.size).join('/')}  ${kb} KB`);
}

(async () => {
  fs.mkdirSync(ICONS, { recursive: true });
  fs.mkdirSync(STORE, { recursive: true });

  const svg = mark();
  fs.writeFileSync(path.join(ICONS, 'logo.svg'), svg + '\n');
  console.log('  wrote icons/logo.svg (source of truth)');

  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  await shoot(page, wrapSvg(mark(), 192, 192), 192, 192, path.join(ICONS, 'icon-192.png'));
  await shoot(page, wrapSvg(mark(), 512, 512), 512, 512, path.join(ICONS, 'icon-512.png'));

  /* Maskable: full bleed, artwork inside the 80% safe circle.
     Verified numerically below rather than by eye. */
  const MASK_SCALE = 0.78;
  const safe = 0.4 * 512;
  if (ART_REACH * MASK_SCALE > safe) {
    throw new Error(`maskable artwork reaches ${(ART_REACH * MASK_SCALE).toFixed(0)}px, safe radius is ${safe}px`);
  }
  await shoot(page, wrapSvg(mark({ scale: MASK_SCALE, bleed: true }), 512, 512), 512, 512,
              path.join(ICONS, 'icon-maskable.png'));

  /* Play listing icon: Play applies its own corner mask, so ship full bleed. */
  await shoot(page, wrapSvg(mark({ bleed: true }), 512, 512), 512, 512,
              path.join(STORE, 'icon-512.png'));

  await shoot(page, featureGraphic(), 1024, 500, path.join(STORE, 'feature-graphic.png'));

  /* Favicons: full bleed, because a rounded mark loses most of its pixels to
   * transparent corners at 16px. */
  const favEntries = [];
  for (const s of [16, 32, 48]) {
    const p = path.join(ICONS, `favicon-${s}.png`);
    await shoot(page, wrapSvg(mark({ bleed: true }), s, s), s, s, p);
    favEntries.push({ size: s, path: p });
  }
  writeIco(favEntries, path.join(ROOT, 'favicon.ico'));

  await browser.close();
  console.log('\ndone.');
})().catch((e) => { console.error(e); process.exit(1); });
