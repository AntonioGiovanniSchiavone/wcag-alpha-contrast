# wcag-alpha-contrast

**Extended WCAG contrast ratio calculator with alpha compositing support.**

[![Tests](https://img.shields.io/badge/tests-59%20passed-brightgreen)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-blue)]()

This library integrates Porter-Duff alpha compositing into the WCAG 2.x contrast ratio pipeline, resolving semi-transparent CSS colors (RGBA, HSLA) to their rendered opaque equivalents before computing contrast. It accompanies the paper:

> **"Extending WCAG's Contrast Ratio Formula to Alpha-Based Colors"**
> A. G. Schiavone — *[Journal TBD]*, 2026.

## The Problem

Current WCAG contrast tools ignore the alpha channel. A tool evaluating `rgba(0,0,0,0.3)` (black at 30% opacity) against white reports **21:1** — the maximum. The *actual* rendered contrast is **2.11:1**, well below the AA threshold. This produces **false positives**: the tool certifies accessibility where none exists.

```
Declared:  rgba(0, 0, 0, 0.3) on #ffffff → Naïve says 21:1 ✓ AA
Rendered:  rgb(179, 179, 179) on #ffffff → Actual is 2.11:1 ✗ AA
                                           ⚠ FALSE POSITIVE
```

## Installation

```bash
npm install wcag-alpha-contrast
```

Or clone and use directly:

```bash
git clone https://github.com/antoniogiovannischiavone/wcag-alpha-contrast.git
cd wcag-alpha-contrast
npm test
```

## Usage

### As a library

```javascript
const { extendedContrastRatio, naiveContrastRatio } = require('wcag-alpha-contrast');

// Semi-transparent black on white
const result = extendedContrastRatio('rgba(0,0,0,0.5)', '#ffffff');
console.log(result.contrastRatio);  // 3.98
console.log(result.aa);            // false (< 4.5)
console.log(result.composited.fg); // { r: 128, g: 128, b: 128 }

// Compare with naïve approach
const naive = naiveContrastRatio('rgba(0,0,0,0.5)', '#ffffff');
console.log(naive);                // 21 — FALSE POSITIVE

// HSL/HSLA support
const hsl = extendedContrastRatio('hsla(300, 100%, 25%, 0.8)', 'white');

// Case B: both semi-transparent (composited on white canvas)
const caseB = extendedContrastRatio('rgba(0,0,0,0.8)', 'rgba(0,0,255,0.5)');

// Custom canvas color
const dark = extendedContrastRatio('rgba(255,255,255,0.5)', 'rgba(0,0,0,0.8)', '#1a1a1a');
```

### As a CLI

```bash
npx wcag-alpha-contrast "rgba(0,0,0,0.3)" "#ffffff"
```

Output:
```
Foreground:    rgba(0,0,0,0.3)
Background:    #ffffff

Composited FG: rgb(179, 179, 179)
Composited BG: rgb(255, 255, 255)

Naïve CR:      21:1 ✓ AA ✓ AAA
Extended CR:   2.11:1 ✗ AA

⚠  FALSE POSITIVE: naïve reports AA pass, but actual contrast fails.
```

## Supported Color Formats

All six CSS Color Module Level 3 formats:

| Format | Example | Alpha |
|--------|---------|-------|
| Named colors | `black`, `navy`, `darkgray` | No |
| Hex | `#f00`, `#800080`, `#ff000080` | #RRGGBBAA only |
| RGB | `rgb(255, 0, 0)` | No |
| RGBA | `rgba(255, 0, 0, 0.5)` | Yes |
| HSL | `hsl(300, 100%, 25%)` | No |
| HSLA | `hsla(300, 100%, 25%, 0.5)` | Yes |

## Web Crawler

The repository includes a crawler for large-scale analysis of alpha-bearing colors in the wild.

### Quick start with Docker

```bash
# Build
docker build -t wcag-alpha-contrast .

# Crawl top 200 sites (results saved in ./data/)
docker run -v $(pwd)/data:/app/data wcag-alpha-contrast

# Or use docker compose
docker compose up
```

### Manual crawl

```bash
# Install crawler dependencies
npm install

# Download Tranco list (top 1M sites)
mkdir -p data
curl -o data/tranco_top1m.csv https://tranco-list.eu/download/X4JNQ/1000000

# Run crawl
npm run crawl:200     # top 200 sites
npm run crawl:1000    # top 1000 sites (for IJHCS version)
```

### Results

The crawler produces a SQLite database (`data/crawl_results.sqlite`) with three tables:

- **`sites`**: crawled domains with status
- **`color_declarations`**: all CSS color values found, classified by model
- **`contrast_pairs`**: text/background pairs with naïve and extended contrast ratios

It also exports `data/analysis_summary.csv` for easy import into statistical tools.

### Key queries

```sql
-- Sites using alpha-bearing colors
SELECT COUNT(DISTINCT site_id) FROM color_declarations WHERE has_alpha = 1;

-- False positive rate
SELECT
  COUNT(*) as total_pairs,
  SUM(is_false_pos) as false_positives,
  ROUND(SUM(is_false_pos) * 100.0 / COUNT(*), 1) as fp_rate
FROM contrast_pairs;

-- Worst false positives
SELECT fg_declared, bg_declared, naive_cr, extended_cr,
       (naive_cr - extended_cr) as overestimation
FROM contrast_pairs
WHERE is_false_pos = 1
ORDER BY overestimation DESC LIMIT 20;

-- Color model distribution
SELECT color_model, COUNT(*) as n,
       ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM color_declarations), 1) as pct
FROM color_declarations
GROUP BY color_model ORDER BY n DESC;
```

## API Reference

### `extendedContrastRatio(foreground, background, [canvas])`

Compute the alpha-aware WCAG contrast ratio.

- **foreground**: CSS color string or `{r, g, b, a}` object
- **background**: CSS color string or `{r, g, b, a}` object
- **canvas**: Optional canvas color (default: `#ffffff`)
- **Returns**: `{ contrastRatio, composited: { fg, bg }, aa, aaa, aaLarge, aaaLarge }`

### `naiveContrastRatio(foreground, background)`

Standard WCAG contrast ratio (ignores alpha). For comparison.

### `parseColor(cssString)`

Parse any CSS Color Level 3 string to `{r, g, b, a}`.

## Project Structure

```
wcag-alpha-contrast/
├── src/
│   └── index.js          # Core library
├── bin/
│   └── cli.js            # CLI tool
├── test/
│   └── test.js           # 59-test suite
├── crawler/
│   └── crawl.js          # Web crawler + analysis
├── validation/
│   └── (paper data scripts)
├── data/
│   └── (crawl results — gitignored)
├── Dockerfile
├── docker-compose.yml
├── package.json
├── LICENSE
└── README.md
```

## Citation

If you use this tool in your research, please cite:

```bibtex
@article{schiavone2026alpha,
  title={Extending WCAG's Contrast Ratio Formula to Alpha-Based Colors},
  author={Schiavone, Antonio Giovanni},
  journal={TBD},
  year={2026}
}
```

## License

MIT — see [LICENSE](LICENSE).
