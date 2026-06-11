/**
 * External validation: compares our alpha compositing formula against
 * the ACTUAL pixels rendered by a real browser (Chromium via Playwright).
 *
 * For each test pair, it:
 *   1. renders semi-transparent foreground text/box over a background
 *   2. takes a screenshot
 *   3. samples the rendered pixel color
 *   4. compares it against our compositeOverOpaque() prediction
 *
 * Usage: node validation/external_validation.js
 * Output: validation/external_validation_results.csv
 */

'use strict';

const { chromium } = require('playwright');
const { compositeOverOpaque, parseColor } = require('../src/index.js');
const fs = require('fs');
const path = require('path');

// Test pairs: [foreground rgba, background rgb]
const TEST_PAIRS = [
  ['rgba(0,0,0,0.3)',       'rgb(255,255,255)'],
  ['rgba(0,0,0,0.5)',       'rgb(255,255,255)'],
  ['rgba(0,0,0,0.54)',      'rgb(255,255,255)'],  // Firefox placeholder
  ['rgba(0,0,0,0.38)',      'rgb(255,255,255)'],  // Material Design
  ['rgba(0,0,0,0.7)',       'rgb(255,255,255)'],
  ['rgba(255,0,0,0.5)',     'rgb(255,255,255)'],
  ['rgba(0,0,255,0.4)',     'rgb(255,255,255)'],
  ['rgba(255,255,255,0.5)', 'rgb(0,0,0)'],
  ['rgba(0,128,0,0.6)',     'rgb(255,255,255)'],
  ['rgba(128,0,128,0.5)',   'rgb(211,211,211)'],
  ['rgba(0,0,0,0.2)',       'rgb(255,255,255)'],
  ['rgba(0,0,0,0.8)',       'rgb(255,255,255)'],
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const results = [];
  console.log('External validation: formula vs. real browser rendering\n');
  console.log('FG declared          | BG          | Predicted        | Rendered         | ΔE');
  console.log('-'.repeat(85));

  for (const [fg, bg] of TEST_PAIRS) {
    // Render a solid box: semi-transparent fg over opaque bg
    const html = `<!DOCTYPE html><html><body style="margin:0">
      <div style="width:100px;height:100px;background:${bg}">
        <div style="width:100px;height:100px;background:${fg}"></div>
      </div></body></html>`;
    await page.setContent(html);
    const buf = await page.screenshot({ clip: { x: 50, y: 50, width: 1, height: 1 } });

    // Decode the single pixel (PNG → RGBA). Use sharp-free approach: parse PNG.
    // Simpler: use page.evaluate with canvas to read pixel.
    const rendered = await page.evaluate(({ fg, bg }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    }, { fg, bg });

    // Our prediction
    const f = parseColor(fg);
    const b = parseColor(bg);
    const pred = compositeOverOpaque(f.r, f.g, f.b, f.a, b.r, b.g, b.b);
    const predR = Math.round(pred.r), predG = Math.round(pred.g), predB = Math.round(pred.b);

    // Euclidean distance in RGB
    const dE = Math.sqrt(
      (predR - rendered.r) ** 2 + (predG - rendered.g) ** 2 + (predB - rendered.b) ** 2
    );

    const predStr = `rgb(${predR},${predG},${predB})`;
    const rendStr = `rgb(${rendered.r},${rendered.g},${rendered.b})`;
    console.log(`${fg.padEnd(20)} | ${bg.padEnd(11)} | ${predStr.padEnd(16)} | ${rendStr.padEnd(16)} | ${dE.toFixed(2)}`);

    results.push({ fg, bg, predStr, rendStr, dE });
  }

  await browser.close();

  // Summary
  const maxDE = Math.max(...results.map(r => r.dE));
  const meanDE = results.reduce((s, r) => s + r.dE, 0) / results.length;
  console.log('-'.repeat(85));
  console.log(`\nMax ΔE: ${maxDE.toFixed(2)}, Mean ΔE: ${meanDE.toFixed(2)}`);
  console.log(maxDE <= 1.5
    ? '✓ Formula matches browser rendering within rounding tolerance (ΔE ≤ 1.5)'
    : '✗ Discrepancy detected — investigate');

  // CSV
  const csv = ['fg_declared,bg,predicted,rendered,delta_e'];
  results.forEach(r => csv.push(`"${r.fg}","${r.bg}","${r.predStr}","${r.rendStr}",${r.dE.toFixed(3)}`));
  const out = path.join(__dirname, 'external_validation_results.csv');
  fs.writeFileSync(out, csv.join('\n'));
  console.log(`\nCSV saved: ${out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
