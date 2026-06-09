/**
 * Test suite for wcag-alpha-contrast
 * Covers all validation cases from the paper.
 *
 * Run: node test/test.js
 */

'use strict';

const {
  extendedContrastRatio,
  naiveContrastRatio,
  parseColor,
  hslToRgb,
} = require('../src/index.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  const ok = Math.abs(actual - expected) <= tolerance;
  assert(ok, `${message} — expected ${expected}, got ${actual}`);
}

// ===== COLOR PARSING =====
console.log('\n=== Color Parsing ===');

const c1 = parseColor('rgba(0, 0, 0, 0.5)');
assert(c1.r === 0 && c1.g === 0 && c1.b === 0 && c1.a === 0.5, 'Parse rgba');

const c2 = parseColor('#800080');
assert(c2.r === 128 && c2.g === 0 && c2.b === 128 && c2.a === 1, 'Parse hex 6-digit');

const c3 = parseColor('#f00');
assert(c3.r === 255 && c3.g === 0 && c3.b === 0 && c3.a === 1, 'Parse hex 3-digit');

const c4 = parseColor('rgb(128, 128, 128)');
assert(c4.r === 128 && c4.g === 128 && c4.b === 128 && c4.a === 1, 'Parse rgb');

const c5 = parseColor('hsl(300, 100%, 25%)');
assert(c5.r === 128 && c5.g === 0 && c5.b === 128 && c5.a === 1, 'Parse hsl → purple');

const c6 = parseColor('hsla(300, 100%, 25%, 0.5)');
assert(c6.r === 128 && c6.g === 0 && c6.b === 128 && c6.a === 0.5, 'Parse hsla');

const c7 = parseColor('black');
assert(c7.r === 0 && c7.g === 0 && c7.b === 0 && c7.a === 1, 'Parse named color');

const c8 = parseColor('transparent');
assert(c8.a === 0, 'Parse transparent');

// ===== LEVEL 1: BACKWARD COMPATIBILITY (α=1 → standard WCAG) =====
console.log('\n=== Level 1: Backward Compatibility ===');

const opaquePairs = [
  { name: 'Black on White',  fg: 'rgb(0,0,0)',       bg: 'rgb(255,255,255)', expected: 21.00 },
  { name: 'White on Black',  fg: 'rgb(255,255,255)', bg: 'rgb(0,0,0)',       expected: 21.00 },
  { name: 'Red on White',    fg: 'rgb(255,0,0)',     bg: 'rgb(255,255,255)', expected: 3.99  },
  { name: 'Navy on Yellow',  fg: 'rgb(0,0,128)',     bg: 'rgb(255,255,0)',   expected: 14.91 },
  { name: 'Gray on LtGray',  fg: 'rgb(128,128,128)', bg: 'rgb(200,200,200)', expected: 2.36  },
  { name: 'Purple on White', fg: 'rgb(128,0,128)',   bg: 'rgb(255,255,255)', expected: 9.42  },
  { name: 'Teal on White',   fg: 'rgb(0,128,128)',   bg: 'rgb(255,255,255)', expected: 4.77  },
  { name: 'Olive on White',  fg: 'rgb(128,128,0)',   bg: 'rgb(255,255,255)', expected: 4.20  },
];

opaquePairs.forEach(p => {
  const ext = extendedContrastRatio(p.fg, p.bg);
  const naive = naiveContrastRatio(p.fg, p.bg);
  assertClose(ext.contrastRatio, p.expected, 0.01, `Extended: ${p.name}`);
  assertClose(naive, p.expected, 0.01, `Naïve: ${p.name}`);
  assertClose(ext.contrastRatio, naive, 0.001, `Match ext==naive: ${p.name}`);
});

// ===== LEVEL 2: CASE A — Semi-transparent FG on opaque BG =====
console.log('\n=== Level 2 Case A: RGBA foreground, opaque background ===');

const caseA = [
  { fg: 'rgba(0,0,0,0.3)',       bg: 'rgb(255,255,255)', extCR: 2.11,  naiveCR: 21.00, aaExt: false },
  { fg: 'rgba(0,0,0,0.5)',       bg: 'rgb(255,255,255)', extCR: 3.98,  naiveCR: 21.00, aaExt: false },
  { fg: 'rgba(0,0,0,0.7)',       bg: 'rgb(255,255,255)', extCR: 8.52,  naiveCR: 21.00, aaExt: true  },
  { fg: 'rgba(255,0,0,0.5)',     bg: 'rgb(255,255,255)', extCR: 2.44,  naiveCR: 4.00,  aaExt: false },
  { fg: 'rgba(0,0,255,0.4)',     bg: 'rgb(255,255,255)', extCR: 2.51,  naiveCR: 8.59,  aaExt: false },
  { fg: 'rgba(0,0,0,0.15)',      bg: 'rgb(255,255,255)', extCR: 1.41,  naiveCR: 21.00, aaExt: false },
];

caseA.forEach(p => {
  const ext = extendedContrastRatio(p.fg, p.bg);
  const naive = naiveContrastRatio(p.fg, p.bg);
  assertClose(ext.contrastRatio, p.extCR, 0.02, `Extended CR: ${p.fg} on ${p.bg}`);
  assertClose(naive, p.naiveCR, 0.02, `Naïve CR: ${p.fg} on ${p.bg}`);
  assert(ext.aa === p.aaExt, `AA verdict: ${p.fg} on ${p.bg} — expected ${p.aaExt}, got ${ext.aa}`);
});

// ===== PLACEHOLDER CASE STUDY =====
console.log('\n=== Placeholder Case Study ===');

const ff = extendedContrastRatio('rgba(0,0,0,0.54)', '#ffffff');
assertClose(ff.contrastRatio, 4.59, 0.05, 'Firefox placeholder on white');
assert(ff.aa === true, 'Firefox placeholder passes AA (barely)');

const md = extendedContrastRatio('rgba(0,0,0,0.38)', '#ffffff');
assertClose(md.contrastRatio, 2.68, 0.05, 'Material Design hint on white');
assert(md.aa === false, 'Material Design hint fails AA');

const mdNaive = naiveContrastRatio('rgba(0,0,0,0.38)', '#ffffff');
assertClose(mdNaive, 21.00, 0.01, 'Material Design hint naïve = 21 (FALSE POSITIVE)');

// ===== HSL/HSLA SUPPORT =====
console.log('\n=== HSL/HSLA ===');

const hslResult = extendedContrastRatio('hsl(0, 100%, 50%)', '#ffffff');
const rgbResult = extendedContrastRatio('rgb(255,0,0)', '#ffffff');
assertClose(hslResult.contrastRatio, rgbResult.contrastRatio, 0.01, 'HSL red == RGB red');

const hslaResult = extendedContrastRatio('hsla(0, 100%, 50%, 0.5)', '#ffffff');
const rgbaResult = extendedContrastRatio('rgba(255,0,0,0.5)', '#ffffff');
assertClose(hslaResult.contrastRatio, rgbaResult.contrastRatio, 0.01, 'HSLA red == RGBA red');

// ===== EDGE CASES =====
console.log('\n=== Edge Cases ===');

const transparent = extendedContrastRatio('transparent', '#ffffff');
assertClose(transparent.contrastRatio, 1.0, 0.01, 'Transparent FG → CR = 1');

const fullOpaque = extendedContrastRatio('rgba(0,0,0,1)', 'rgba(255,255,255,1)');
assertClose(fullOpaque.contrastRatio, 21.0, 0.01, 'α=1 both → 21:1');

// ===== RESULTS =====
console.log(`\n${'='.repeat(40)}`);
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed ✓');
}
