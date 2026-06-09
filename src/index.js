/**
 * wcag-alpha-contrast
 * Extended WCAG contrast ratio calculator with alpha compositing support.
 *
 * Integrates the Porter-Duff "over" operator into the WCAG 2.x contrast
 * ratio pipeline, resolving semi-transparent CSS colors (RGBA, HSLA) to
 * their rendered opaque equivalents before computing contrast.
 *
 * @author Antonio Giovanni Schiavone
 * @license MIT
 * @see https://github.com/antoniogiovannischiavone/wcag-alpha-contrast
 */

'use strict';

// ---------------------------------------------------------------------------
// Step 3: sRGB linearization (WCAG 2.x formula)
// ---------------------------------------------------------------------------
function linearize(x) {
  return x <= 0.03928
    ? x / 12.92
    : Math.pow((x + 0.055) / 1.055, 2.4);
}

// ---------------------------------------------------------------------------
// Steps 2-4: relative luminance from 8-bit RGB
// ---------------------------------------------------------------------------
function relativeLuminance(r, g, b) {
  return (
    0.2126 * linearize(r / 255) +
    0.7152 * linearize(g / 255) +
    0.0722 * linearize(b / 255)
  );
}

// ---------------------------------------------------------------------------
// Step 5: WCAG contrast ratio from two luminance values
// ---------------------------------------------------------------------------
function contrastRatioFromLuminance(L1, L2) {
  const lighter = Math.max(L1, L2);
  const darker  = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Step 1a: Porter-Duff "over" — composite fg onto opaque bg (Case A)
// ---------------------------------------------------------------------------
function compositeOverOpaque(fgR, fgG, fgB, fgA, bgR, bgG, bgB) {
  return {
    r: fgR * fgA + bgR * (1 - fgA),
    g: fgG * fgA + bgG * (1 - fgA),
    b: fgB * fgA + bgB * (1 - fgA),
  };
}

// ---------------------------------------------------------------------------
// HSL → RGB conversion (CSS Color Module Level 3, Section 4.2.4)
// ---------------------------------------------------------------------------
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r1, g1, b1;
  if      (h < 60)  { r1 = c; g1 = x; b1 = 0; }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
  else              { r1 = c; g1 = 0; b1 = x; }

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

// ---------------------------------------------------------------------------
// CSS color string parser
// Supports: rgb(), rgba(), hsl(), hsla(), hex (#RGB, #RRGGBB), named colors
// ---------------------------------------------------------------------------
const CSS_NAMED_COLORS = {
  black: [0,0,0], white: [255,255,255], red: [255,0,0], green: [0,128,0],
  blue: [0,0,255], yellow: [255,255,0], cyan: [0,255,255], magenta: [255,0,255],
  silver: [192,192,192], gray: [128,128,128], grey: [128,128,128],
  maroon: [128,0,0], olive: [128,128,0], lime: [0,255,0], aqua: [0,255,255],
  teal: [0,128,128], navy: [0,0,128], fuchsia: [255,0,255], purple: [128,0,128],
  orange: [255,165,0], darkgray: [169,169,169], darkgrey: [169,169,169],
  lightgray: [211,211,211], lightgrey: [211,211,211],
  transparent: [0,0,0], // alpha handled separately
};

/**
 * Parse a CSS color string to { r, g, b, a }.
 * @param {string} color - CSS color value
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
function parseColor(color) {
  if (typeof color !== 'string') {
    throw new TypeError(`Expected string, got ${typeof color}`);
  }

  const s = color.trim().toLowerCase();

  // transparent
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  // Named colors
  if (CSS_NAMED_COLORS[s]) {
    const [r, g, b] = CSS_NAMED_COLORS[s];
    return { r, g, b, a: 1 };
  }

  // Hex: #RGB or #RRGGBB
  const hexMatch = s.match(/^#([0-9a-f]{3,8})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
  }

  // rgb() / rgba()
  const rgbaMatch = s.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/
  );
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1], 10),
      g: parseInt(rgbaMatch[2], 10),
      b: parseInt(rgbaMatch[3], 10),
      a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
    };
  }

  // hsl() / hsla()
  const hslaMatch = s.match(
    /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+))?\s*\)$/
  );
  if (hslaMatch) {
    const rgb = hslToRgb(
      parseFloat(hslaMatch[1]),
      parseFloat(hslaMatch[2]) / 100,
      parseFloat(hslaMatch[3]) / 100
    );
    return {
      ...rgb,
      a: hslaMatch[4] !== undefined ? parseFloat(hslaMatch[4]) : 1,
    };
  }

  throw new Error(`Unsupported color format: "${color}"`);
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Compute the extended WCAG contrast ratio between two colors,
 * accounting for alpha transparency via Porter-Duff compositing.
 *
 * @param {string|object} foreground - CSS color string or {r,g,b,a} object
 * @param {string|object} background - CSS color string or {r,g,b,a} object
 * @param {string|object} [canvas='#ffffff'] - Canvas color (opaque)
 * @returns {{ contrastRatio: number, composited: { fg: object, bg: object }, aa: boolean, aaa: boolean }}
 */
function extendedContrastRatio(foreground, background, canvas = '#ffffff') {
  const fg = typeof foreground === 'string' ? parseColor(foreground) : foreground;
  const bg = typeof background === 'string' ? parseColor(background) : background;
  const cv = typeof canvas     === 'string' ? parseColor(canvas)     : canvas;

  // Step 1a: resolve background onto canvas if semi-transparent
  let bgResolved;
  if (bg.a < 1) {
    bgResolved = compositeOverOpaque(bg.r, bg.g, bg.b, bg.a, cv.r, cv.g, cv.b);
  } else {
    bgResolved = { r: bg.r, g: bg.g, b: bg.b };
  }

  // Step 1b: resolve foreground onto resolved background
  let fgResolved;
  if (fg.a < 1) {
    fgResolved = compositeOverOpaque(fg.r, fg.g, fg.b, fg.a, bgResolved.r, bgResolved.g, bgResolved.b);
  } else {
    fgResolved = { r: fg.r, g: fg.g, b: fg.b };
  }

  // Steps 2-5: standard WCAG pipeline
  const L_fg = relativeLuminance(fgResolved.r, fgResolved.g, fgResolved.b);
  const L_bg = relativeLuminance(bgResolved.r, bgResolved.g, bgResolved.b);
  const cr   = contrastRatioFromLuminance(L_fg, L_bg);

  return {
    contrastRatio: Math.round(cr * 100) / 100,
    composited: {
      fg: {
        r: Math.round(fgResolved.r),
        g: Math.round(fgResolved.g),
        b: Math.round(fgResolved.b),
      },
      bg: {
        r: Math.round(bgResolved.r),
        g: Math.round(bgResolved.g),
        b: Math.round(bgResolved.b),
      },
    },
    aa:  cr >= 4.5,
    aaa: cr >= 7.0,
    aaLarge:  cr >= 3.0,
    aaaLarge: cr >= 4.5,
  };
}

/**
 * Standard WCAG contrast ratio (ignores alpha — naïve approach).
 * Provided for comparison purposes.
 */
function naiveContrastRatio(foreground, background) {
  const fg = typeof foreground === 'string' ? parseColor(foreground) : foreground;
  const bg = typeof background === 'string' ? parseColor(background) : background;

  const L_fg = relativeLuminance(fg.r, fg.g, fg.b);
  const L_bg = relativeLuminance(bg.r, bg.g, bg.b);
  return Math.round(contrastRatioFromLuminance(L_fg, L_bg) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  extendedContrastRatio,
  naiveContrastRatio,
  parseColor,
  relativeLuminance,
  compositeOverOpaque,
  hslToRgb,
  linearize,
};
