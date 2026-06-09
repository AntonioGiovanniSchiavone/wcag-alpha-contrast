/**
 * Generate all validation data for the paper.
 * Run: node validation/generate_paper_data.js
 */

'use strict';

const {
  extendedContrastRatio,
  naiveContrastRatio,
  compositeOverOpaque,
} = require('../src/index.js');

function r2(x) { return Math.round(x * 100) / 100; }
function rgbStr(c) { return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`; }

// ===== TABLE 2: Consistency Proof =====
console.log('TABLE 2 — Consistency Proof (α=1)\n');
console.log('| Color Pair | WCAG Standard | Extended (α=1) | Match |');
console.log('|---|---|---|---|');

const opaque = [
  ['Black on White',     'rgb(0,0,0)',       'rgb(255,255,255)'],
  ['White on Black',     'rgb(255,255,255)', 'rgb(0,0,0)'],
  ['Red on White',       'rgb(255,0,0)',     'rgb(255,255,255)'],
  ['Navy on Yellow',     'rgb(0,0,128)',     'rgb(255,255,0)'],
  ['Gray on Light Gray', 'rgb(128,128,128)', 'rgb(200,200,200)'],
  ['Purple on White',    'rgb(128,0,128)',   'rgb(255,255,255)'],
  ['Teal on White',      'rgb(0,128,128)',   'rgb(255,255,255)'],
  ['Olive on White',     'rgb(128,128,0)',   'rgb(255,255,255)'],
];

opaque.forEach(([name, fg, bg]) => {
  const ext = extendedContrastRatio(fg, bg);
  const naive = naiveContrastRatio(fg, bg);
  const match = ext.contrastRatio === naive ? '✓' : '✗';
  console.log(`| ${name} | ${naive} | ${ext.contrastRatio} | ${match} |`);
});

// ===== TABLE 3: Case A =====
console.log('\n\nTABLE 3 — Case A: Semi-transparent FG on opaque BG\n');
console.log('| Color Pair | Rendered | Naïve CR | Extended CR | AA Naïve | AA Ext | FP |');
console.log('|---|---|---|---|---|---|---|');

const caseA = [
  ['Black α=0.3 on White',        'rgba(0,0,0,0.3)',       'rgb(255,255,255)'],
  ['Black α=0.5 on White',        'rgba(0,0,0,0.5)',       'rgb(255,255,255)'],
  ['Black α=0.7 on White',        'rgba(0,0,0,0.7)',       'rgb(255,255,255)'],
  ['Black α=1.0 on White',        'rgba(0,0,0,1)',         'rgb(255,255,255)'],
  ['Red α=0.5 on White',          'rgba(255,0,0,0.5)',     'rgb(255,255,255)'],
  ['Blue α=0.4 on White',         'rgba(0,0,255,0.4)',     'rgb(255,255,255)'],
  ['White α=0.5 on Black',        'rgba(255,255,255,0.5)', 'rgb(0,0,0)'],
  ['Navy α=0.6 on Yellow',        'rgba(0,0,128,0.6)',     'rgb(255,255,0)'],
  ['Green α=0.8 on White',        'rgba(0,128,0,0.8)',     'rgb(255,255,255)'],
  ['Black α=0.15 on White',       'rgba(0,0,0,0.15)',      'rgb(255,255,255)'],
  ['Purple α=0.5 on LightGray',   'rgba(128,0,128,0.5)',   'rgb(211,211,211)'],
  ['DarkBlue α=0.3 on LightBlue', 'rgba(0,0,139,0.3)',     'rgb(173,216,230)'],
];

let fpCount = 0;
caseA.forEach(([name, fg, bg]) => {
  const ext = extendedContrastRatio(fg, bg);
  const naive = naiveContrastRatio(fg, bg);
  const naiveAA = naive >= 4.5 ? 'PASS' : 'FAIL';
  const extAA = ext.aa ? 'PASS' : 'FAIL';
  const fp = (naiveAA === 'PASS' && extAA === 'FAIL') ? '⚠' : '';
  if (fp) fpCount++;
  console.log(`| ${name} | ${rgbStr(ext.composited.fg)} | ${naive} | ${ext.contrastRatio} | ${naiveAA} | ${extAA} | ${fp} |`);
});
console.log(`\nFalse positives: ${fpCount}/${caseA.length} (${r2(fpCount/caseA.length*100)}%)`);

// ===== TABLE 5: Alpha Degradation =====
console.log('\n\nTABLE 5 — Alpha Degradation: Black on White\n');
console.log('| Alpha | Rendered | CR | AA | AAA |');
console.log('|---|---|---|---|---|');

for (let a = 0; a <= 1.001; a += 0.05) {
  a = r2(a);
  if (a > 1) a = 1;
  const ext = extendedContrastRatio(`rgba(0,0,0,${a})`, '#ffffff');
  console.log(`| ${a} | ${rgbStr(ext.composited.fg)} | ${ext.contrastRatio} | ${ext.aa ? 'PASS' : 'FAIL'} | ${ext.aaa ? 'PASS' : 'FAIL'} |`);
}

// ===== TABLE 6: Placeholder Case Study =====
console.log('\n\nTABLE 6 — Placeholder Text Case Study\n');
console.log('| Implementation | Declared | Composited | Naïve | Extended | AA | FP |');
console.log('|---|---|---|---|---|---|---|');

const placeholders = [
  ['Chrome/Edge/Safari', 'rgb(169,169,169)'],
  ['Firefox (black)',     'rgba(0,0,0,0.54)'],
  ['Bootstrap 5',        'rgb(108,117,125)'],
  ['Material Design',    'rgba(0,0,0,0.38)'],
  ['Common rgba 0.3',    'rgba(0,0,0,0.3)'],
  ['Styled rgba 0.6',    'rgba(102,102,102,0.6)'],
];

placeholders.forEach(([name, fg]) => {
  const ext = extendedContrastRatio(fg, '#ffffff');
  const naive = naiveContrastRatio(fg, '#ffffff');
  const naiveAA = naive >= 4.5 ? 'PASS' : 'FAIL';
  const extAA = ext.aa ? 'PASS' : 'FAIL';
  const fp = (naiveAA === 'PASS' && extAA === 'FAIL') ? '⚠' : '';
  console.log(`| ${name} | ${fg} | ${rgbStr(ext.composited.fg)} | ${naive} | ${ext.contrastRatio} | ${extAA} | ${fp} |`);
});

console.log('\n\nDone. All paper data generated.');
