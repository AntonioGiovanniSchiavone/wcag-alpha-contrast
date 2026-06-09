/**
 * wcag-alpha-contrast crawler
 * Crawls websites to extract CSS color declarations and compute
 * contrast ratios, comparing naïve vs extended approaches.
 *
 * Prerequisites: npm install playwright better-sqlite3
 * Usage: node crawler/crawl.js [--sites 200] [--db results.sqlite] [--proxy http://host:port]
 */

'use strict';

const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const { extendedContrastRatio, naiveContrastRatio, parseColor } = require('../src/index.js');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEFAULT_SITES = 200;
const DEFAULT_DB    = path.join(__dirname, '..', 'data', 'crawl_results.sqlite');
const TRANCO_CACHE  = path.join(__dirname, '..', 'data', 'tranco_top1m.csv');
const TIMEOUT_MS    = 30000;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const config = { sites: DEFAULT_SITES, db: DEFAULT_DB, resume: false, proxy: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sites'  && args[i + 1])  config.sites  = parseInt(args[++i], 10);
    if (args[i] === '--db'     && args[i + 1])  config.db     = args[++i];
    if (args[i] === '--proxy'  && args[i + 1])  config.proxy  = args[++i];
    if (args[i] === '--resume')                 config.resume = true;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rank        INTEGER NOT NULL,
      domain      TEXT NOT NULL UNIQUE,
      url         TEXT NOT NULL,
      status      TEXT DEFAULT 'pending',  -- pending | crawled | error
      error_msg   TEXT,
      crawled_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS color_declarations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id     INTEGER NOT NULL REFERENCES sites(id),
      selector    TEXT,
      property    TEXT NOT NULL,          -- color, background-color, border-color, etc.
      value       TEXT NOT NULL,          -- raw CSS value
      color_model TEXT,                   -- rgb, rgba, hsl, hsla, hex, keyword
      has_alpha   INTEGER DEFAULT 0,
      alpha_value REAL
    );

    CREATE TABLE IF NOT EXISTS contrast_pairs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id         INTEGER NOT NULL REFERENCES sites(id),
      element_tag     TEXT,
      element_text    TEXT,
      fg_declared     TEXT NOT NULL,
      bg_declared     TEXT NOT NULL,
      fg_composited   TEXT,
      bg_composited   TEXT,
      naive_cr        REAL,
      extended_cr     REAL,
      aa_naive        INTEGER,
      aa_extended     INTEGER,
      is_false_pos    INTEGER DEFAULT 0,  -- naive PASS, extended FAIL
      is_false_neg    INTEGER DEFAULT 0   -- naive FAIL, extended PASS
    );

    CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
    CREATE INDEX IF NOT EXISTS idx_colors_site ON color_declarations(site_id);
    CREATE INDEX IF NOT EXISTS idx_pairs_site ON contrast_pairs(site_id);
    CREATE INDEX IF NOT EXISTS idx_pairs_fp ON contrast_pairs(is_false_pos);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Tranco list loader
// ---------------------------------------------------------------------------
async function loadTrancoList(n) {
  if (fs.existsSync(TRANCO_CACHE)) {
    const lines = fs.readFileSync(TRANCO_CACHE, 'utf-8').trim().split('\n');
    return lines.slice(0, n).map((line, i) => {
      const parts = line.split(',');
      return { rank: parseInt(parts[0]) || i + 1, domain: (parts[1] || parts[0]).trim() };
    });
  }

  // Fallback: seed list for testing
  console.log('⚠ Tranco list not found. Using seed list for testing.');
  const seeds = [
    'google.com', 'youtube.com', 'facebook.com', 'amazon.com', 'wikipedia.org',
    'twitter.com', 'instagram.com', 'linkedin.com', 'reddit.com', 'netflix.com',
    'microsoft.com', 'apple.com', 'github.com', 'stackoverflow.com', 'medium.com',
    'stripe.com', 'notion.so', 'figma.com', 'vercel.com', 'tailwindcss.com',
  ];
  return seeds.slice(0, n).map((d, i) => ({ rank: i + 1, domain: d }));
}

// ---------------------------------------------------------------------------
// Color model classifier
// ---------------------------------------------------------------------------
function classifyColor(value) {
  const v = value.trim().toLowerCase();
  if (v.startsWith('rgba('))  return { model: 'rgba',    hasAlpha: true  };
  if (v.startsWith('rgb('))   return { model: 'rgb',     hasAlpha: false };
  if (v.startsWith('hsla('))  return { model: 'hsla',    hasAlpha: true  };
  if (v.startsWith('hsl('))   return { model: 'hsl',     hasAlpha: false };
  if (v.startsWith('#')) {
    if (v.length === 9) return { model: 'hex8', hasAlpha: true };
    return { model: 'hex', hasAlpha: false };
  }
  if (v === 'transparent')    return { model: 'keyword', hasAlpha: true  };
  return { model: 'keyword', hasAlpha: false };
}

// ---------------------------------------------------------------------------
// Page color extraction function (runs in browser context via Playwright)
// BUG FIX: this is now a proper function, not a string template.
// page.evaluate() receives it directly and executes it in the browser.
// ---------------------------------------------------------------------------
function extractColors() {
  const results = { declarations: [], pairs: [] };
  const textElements = document.querySelectorAll(
    'p, span, a, h1, h2, h3, h4, h5, h6, li, td, th, label, button, input, textarea, div, section'
  );

  const seen = new Set();

  for (const el of textElements) {
    // Skip hidden elements
    if (el.offsetParent === null && el.tagName !== 'BODY') continue;

    const style = window.getComputedStyle(el);
    const fgColor = style.color;
    const bgColor = style.backgroundColor;

    if (!fgColor || !bgColor) continue;

    // Record color declarations
    if (!seen.has('fg:' + fgColor)) {
      results.declarations.push({ property: 'color', value: fgColor });
      seen.add('fg:' + fgColor);
    }
    if (!seen.has('bg:' + bgColor)) {
      results.declarations.push({ property: 'background-color', value: bgColor });
      seen.add('bg:' + bgColor);
    }

    // Record contrast pair (skip if bg is fully transparent — need to walk up)
    if (bgColor !== 'rgba(0, 0, 0, 0)') {
      const pairKey = fgColor + '|' + bgColor;
      if (!seen.has('pair:' + pairKey)) {
        const text = (el.textContent || '').trim().substring(0, 100);
        if (text.length > 0) {
          results.pairs.push({
            tag: el.tagName.toLowerCase(),
            text: text,
            fg: fgColor,
            bg: bgColor,
          });
          seen.add('pair:' + pairKey);
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main crawl function
// ---------------------------------------------------------------------------
async function crawlSite(browser, db, siteRow) {
  const url = `https://${siteRow.domain}`;
  const insertDecl = db.prepare(`
    INSERT INTO color_declarations (site_id, property, value, color_model, has_alpha, alpha_value)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertPair = db.prepare(`
    INSERT INTO contrast_pairs
      (site_id, element_tag, element_text, fg_declared, bg_declared,
       fg_composited, bg_composited, naive_cr, extended_cr,
       aa_naive, aa_extended, is_false_pos, is_false_neg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForTimeout(2000); // let JS render

    // BUG FIX: pass function reference directly instead of string template
    const data = await page.evaluate(extractColors);

    if (!data || !data.declarations || data.declarations.length === 0) {
      db.prepare(`UPDATE sites SET status = 'error', error_msg = 'No data extracted' WHERE id = ?`).run(siteRow.id);
      console.log(`  ✗ ${siteRow.rank}. ${siteRow.domain} — No data extracted`);
      return;
    }

    // Process declarations
    for (const decl of data.declarations) {
      const cls = classifyColor(decl.value);
      let alpha = null;
      try {
        const parsed = parseColor(decl.value);
        alpha = parsed.a;
      } catch (e) { /* skip unparseable */ }

      insertDecl.run(siteRow.id, decl.property, decl.value, cls.model, cls.hasAlpha ? 1 : 0, alpha);
    }

    // Process pairs
    for (const pair of data.pairs) {
      try {
        const ext   = extendedContrastRatio(pair.fg, pair.bg);
        const naive = naiveContrastRatio(pair.fg, pair.bg);
        const aaNaive = naive >= 4.5 ? 1 : 0;
        const aaExt   = ext.aa ? 1 : 0;
        const fp = (aaNaive === 1 && aaExt === 0) ? 1 : 0;
        const fn = (aaNaive === 0 && aaExt === 1) ? 1 : 0;

        const fgC = ext.composited.fg;
        const bgC = ext.composited.bg;

        insertPair.run(
          siteRow.id, pair.tag, pair.text, pair.fg, pair.bg,
          `rgb(${fgC.r},${fgC.g},${fgC.b})`,
          `rgb(${bgC.r},${bgC.g},${bgC.b})`,
          naive, ext.contrastRatio,
          aaNaive, aaExt, fp, fn
        );
      } catch (e) { /* skip unparseable color pairs */ }
    }

    db.prepare(`UPDATE sites SET status = 'crawled', crawled_at = datetime('now') WHERE id = ?`).run(siteRow.id);
    console.log(`  ✓ ${siteRow.rank}. ${siteRow.domain} — ${data.declarations.length} colors, ${data.pairs.length} pairs`);

  } catch (err) {
    db.prepare(`UPDATE sites SET status = 'error', error_msg = ? WHERE id = ?`).run(err.message.substring(0, 500), siteRow.id);
    console.log(`  ✗ ${siteRow.rank}. ${siteRow.domain} — ${err.message.substring(0, 80)}`);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Analysis queries
// ---------------------------------------------------------------------------
function runAnalysis(db) {
  console.log('\n' + '='.repeat(60));
  console.log('CRAWL ANALYSIS');
  console.log('='.repeat(60));

  const sitesTotal   = db.prepare(`SELECT COUNT(*) as n FROM sites WHERE status = 'crawled'`).get().n;
  const sitesError   = db.prepare(`SELECT COUNT(*) as n FROM sites WHERE status = 'error'`).get().n;
  console.log(`\nSites crawled: ${sitesTotal}, errors: ${sitesError}`);

  if (sitesTotal === 0) {
    console.log('\nNo sites were successfully crawled. Check proxy settings and try again.');
    return;
  }

  const declTotal    = db.prepare(`SELECT COUNT(*) as n FROM color_declarations`).get().n;
  const declAlpha    = db.prepare(`SELECT COUNT(*) as n FROM color_declarations WHERE has_alpha = 1`).get().n;
  if (declTotal > 0) {
    console.log(`Color declarations: ${declTotal} total, ${declAlpha} with alpha (${(declAlpha/declTotal*100).toFixed(1)}%)`);
  }

  const byModel = db.prepare(`SELECT color_model, COUNT(*) as n FROM color_declarations GROUP BY color_model ORDER BY n DESC`).all();
  console.log('\nBy color model:');
  byModel.forEach(r => console.log(`  ${r.color_model.padEnd(10)} ${r.n}`));

  const pairsTotal   = db.prepare(`SELECT COUNT(*) as n FROM contrast_pairs`).get().n;
  const pairsFP      = db.prepare(`SELECT COUNT(*) as n FROM contrast_pairs WHERE is_false_pos = 1`).get().n;
  const pairsFN      = db.prepare(`SELECT COUNT(*) as n FROM contrast_pairs WHERE is_false_neg = 1`).get().n;
  console.log(`\nContrast pairs: ${pairsTotal}`);
  if (pairsTotal > 0) {
    console.log(`False positives: ${pairsFP} (${(pairsFP/pairsTotal*100).toFixed(1)}%)`);
    console.log(`False negatives: ${pairsFN} (${(pairsFN/pairsTotal*100).toFixed(1)}%)`);
  }

  const sitesWithAlpha = db.prepare(`
    SELECT COUNT(DISTINCT site_id) as n FROM color_declarations WHERE has_alpha = 1
  `).get().n;
  console.log(`\nSites using alpha-bearing colors: ${sitesWithAlpha} / ${sitesTotal} (${(sitesWithAlpha/sitesTotal*100).toFixed(1)}%)`);

  const worstFP = db.prepare(`
    SELECT fg_declared, bg_declared, naive_cr, extended_cr, element_tag, element_text
    FROM contrast_pairs WHERE is_false_pos = 1
    ORDER BY (naive_cr - extended_cr) DESC LIMIT 10
  `).all();
  if (worstFP.length > 0) {
    console.log('\nTop 10 worst false positives (largest CR discrepancy):');
    worstFP.forEach((r, i) => {
      console.log(`  ${i+1}. FG: ${r.fg_declared}, BG: ${r.bg_declared}`);
      console.log(`     Naïve: ${r.naive_cr}:1 → Extended: ${r.extended_cr}:1 (${r.element_tag}: "${r.element_text.substring(0,40)}")`);
    });
  }

  // Export summary CSV
  const csvPath = path.join(path.dirname(db.name), 'analysis_summary.csv');
  const allPairs = db.prepare(`
    SELECT site_id, element_tag, fg_declared, bg_declared,
           fg_composited, bg_composited, naive_cr, extended_cr,
           aa_naive, aa_extended, is_false_pos, is_false_neg
    FROM contrast_pairs
  `).all();

  const csvLines = ['site_id,tag,fg_declared,bg_declared,fg_composited,bg_composited,naive_cr,extended_cr,aa_naive,aa_extended,false_pos,false_neg'];
  allPairs.forEach(r => {
    csvLines.push(`${r.site_id},${r.element_tag},"${r.fg_declared}","${r.bg_declared}","${r.fg_composited}","${r.bg_composited}",${r.naive_cr},${r.extended_cr},${r.aa_naive},${r.aa_extended},${r.is_false_pos},${r.is_false_neg}`);
  });
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`\nCSV exported: ${csvPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const config = parseArgs();
  console.log(`\nwcag-alpha-contrast crawler`);
  console.log(`Sites: ${config.sites}, DB: ${config.db}`);
  if (config.proxy) console.log(`Proxy: ${config.proxy}`);
  console.log('');

  const db = initDb(config.db);

  // Load site list
  const existingSites = db.prepare(`SELECT COUNT(*) as n FROM sites`).get().n;
  if (existingSites === 0 || !config.resume) {
    if (existingSites > 0 && !config.resume) {
      db.exec(`DELETE FROM contrast_pairs; DELETE FROM color_declarations; DELETE FROM sites;`);
    }
    const sites = await loadTrancoList(config.sites);
    const insertSite = db.prepare(`INSERT OR IGNORE INTO sites (rank, domain, url) VALUES (?, ?, ?)`);
    const insertMany = db.transaction((sites) => {
      for (const s of sites) insertSite.run(s.rank, s.domain, `https://${s.domain}`);
    });
    insertMany(sites);
    console.log(`Loaded ${sites.length} sites into database.`);
  }

  // Crawl pending sites
  const pending = db.prepare(`SELECT * FROM sites WHERE status = 'pending' ORDER BY rank`).all();
  console.log(`\nCrawling ${pending.length} pending sites...\n`);

  // BUG FIX: proxy is now configurable via --proxy flag
  const launchOptions = { headless: true };
  if (config.proxy) {
    launchOptions.proxy = { server: config.proxy };
  }

  const browser = await chromium.launch(launchOptions);

  for (const site of pending) {
    await crawlSite(browser, db, site);
  }

  await browser.close();

  // Analysis
  runAnalysis(db);

  db.close();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
