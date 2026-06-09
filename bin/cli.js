#!/usr/bin/env node

/**
 * wcag-alpha-contrast CLI
 * Usage: npx wcag-alpha-contrast <foreground> <background> [canvas]
 *
 * Examples:
 *   npx wcag-alpha-contrast "rgba(0,0,0,0.5)" "#ffffff"
 *   npx wcag-alpha-contrast "hsla(300,100%,25%,0.8)" "rgb(255,255,255)" "#f0f0f0"
 */

'use strict';

const { extendedContrastRatio, naiveContrastRatio } = require('../src/index.js');

const args = process.argv.slice(2);

if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
  console.log(`
wcag-alpha-contrast — Extended WCAG contrast ratio with alpha support

Usage:
  wcag-alpha-contrast <foreground> <background> [canvas]

Arguments:
  foreground   CSS color (e.g. "rgba(0,0,0,0.5)", "#333", "navy")
  background   CSS color (e.g. "#ffffff", "rgb(255,255,255)")
  canvas       Optional canvas color for Case B (default: #ffffff)

Examples:
  wcag-alpha-contrast "rgba(0,0,0,0.3)" "#ffffff"
  wcag-alpha-contrast "hsla(0,100%,50%,0.5)" "rgb(200,200,200)" "#f0f0f0"
`);
  process.exit(0);
}

const [fg, bg, canvas] = args;

try {
  const ext   = extendedContrastRatio(fg, bg, canvas);
  const naive = naiveContrastRatio(fg, bg);

  const fgC = ext.composited.fg;
  const bgC = ext.composited.bg;

  console.log(`
  Foreground:    ${fg}
  Background:    ${bg}${canvas ? `\n  Canvas:        ${canvas}` : ''}

  Composited FG: rgb(${fgC.r}, ${fgC.g}, ${fgC.b})
  Composited BG: rgb(${bgC.r}, ${bgC.g}, ${bgC.b})

  Naïve CR:      ${naive}:1 ${naive >= 4.5 ? '✓ AA' : '✗ AA'}${naive >= 7 ? ' ✓ AAA' : ''}
  Extended CR:   ${ext.contrastRatio}:1 ${ext.aa ? '✓ AA' : '✗ AA'}${ext.aaa ? ' ✓ AAA' : ''}

  ${naive >= 4.5 && !ext.aa ? '⚠  FALSE POSITIVE: naïve reports AA pass, but actual contrast fails.' : ''}
  ${!naive >= 4.5 && ext.aa ? '⚠  FALSE NEGATIVE: naïve reports AA fail, but actual contrast passes.' : ''}
  `.trim());
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
