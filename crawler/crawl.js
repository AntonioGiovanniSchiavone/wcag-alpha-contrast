/**
 * wcag-alpha-contrast crawler
 * Crawls websites to extract CSS color declarations and compute
 * contrast ratios, comparing naïve vs extended approaches.
 *
 * Usage: node crawler/crawl.js [--sites 500] [--proxy http://host:port] [--resume]
 */

'use strict';

const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const { extendedContrastRatio, naiveContrastRatio, parseColor } = require('../src/index.js');
const fs = require('fs');
const path = require('path');

const DEFAULT_SITES = 200;
const DEFAULT_DB    = path.join(__dirname, '..', 'data', 'crawl_results.sqlite');
const TRANCO_CACHE  = path.join(__dirname, '..', 'data', 'tranco_top1m.csv');
const TIMEOUT_MS    = 30000;

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { sites: DEFAULT_SITES, db: DEFAULT_DB, resume: false, proxy: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sites'  && args[i + 1]) config.sites  = parseInt(args[++i], 10);
    if (args[i] === '--db'     && args[i + 1]) config.db     = args[++i];
    if (args[i] === '--proxy'  && args[i + 1]) config.proxy  = args[++i];
    if (args[i] === '--resume')                config.resume = true;
  }
  return config;
}

function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rank INTEGER NOT NULL,
      domain TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
      status TEXT DEFAULT 'pending', error_msg TEXT, crawled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS color_declarations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL REFERENCES sites(id),
      selector TEXT, property TEXT NOT NULL, value TEXT NOT NULL,
      color_model TEXT, has_alpha INTEGER DEFAULT 0, alpha_value REAL
    );
    CREATE TABLE IF NOT EXISTS contrast_pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL REFERENCES sites(id),
      element_tag TEXT, element_text TEXT,
      fg_declared TEXT NOT NULL, bg_declared TEXT NOT NULL,
      fg_composited TEXT, bg_composited TEXT,
      naive_cr REAL, extended_cr REAL,
      aa_naive INTEGER, aa_extended INTEGER,
      is_false_pos INTEGER DEFAULT 0, is_false_neg INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
    CREATE INDEX IF NOT EXISTS idx_pairs_fp ON contrast_pairs(is_false_pos);
  `);
  return db;
}

async function loadTrancoList(n) {
  if (fs.existsSync(TRANCO_CACHE)) {
    const lines = fs.readFileSync(TRANCO_CACHE, 'utf-8').trim().split('\n');
    return lines.slice(0, n).map((line, i) => {
      const parts = line.split(',');
      return { rank: parseInt(parts[0]) || i + 1, domain: (parts[1] || parts[0]).trim() };
    });
  }
  console.log('ERROR: Tranco list not found at ' + TRANCO_CACHE);
  console.log('Download it first:');
  console.log('  curl -L -o data/top-1m.csv.zip https://tranco-list.eu/download/daily/top-1m.csv.zip');
  console.log('  Then extract and rename to data/tranco_top1m.csv');
  process.exit(1);
}

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
// Color extraction — runs inside browser via page.evaluate(extractColors)
// MUST be a plain function (no closures, no require) — it's serialized.
// ---------------------------------------------------------------------------
function extractColors() {
  var results = { declarations: [], pairs: [] };
  var textElements = document.querySelectorAll(
    'p, span, a, h1, h2, h3, h4, h5, h6, li, td, th, label, button, input, textarea, div, section'
  );
  var seen = {};

  for (var i = 0; i < textElements.length; i++) {
    var el = textElements[i];
    if (el.offsetParent === null && el.tagName !== 'BODY') continue;

    var style = window.getComputedStyle(el);
    var fgColor = style.color;
    var bgColor = style.backgroundColor;
    if (!fgColor || !bgColor) continue;

    if (!seen['fg:' + fgColor]) {
      results.declarations.push({ property: 'color', value: fgColor });
      seen['fg:' + fgColor] = true;
    }
    if (!seen['bg:' + bgColor]) {
      results.declarations.push({ property: 'background-color', value: bgColor });
      seen['bg:' + bgColor] = true;
    }

    if (bgColor !== 'rgba(0, 0, 0, 0)') {
      var pairKey = fgColor + '|' + bgColor;
      if (!seen['pair:' + pairKey]) {
        var text = (el.textContent || '').trim().substring(0, 100);
        if (text.length > 0) {
          results.pairs.push({ tag: el.tagName.toLowerCase(), text: text, fg: fgColor, bg: bgColor });
          seen['pair:' + pairKey] = true;
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Crawl a single site
// ---------------------------------------------------------------------------
async function crawlSite(browser, db, siteRow) {
  const url = 'https://' + siteRow.domain;
  const insertDecl = db.prepare(
    'INSERT INTO color_declarations (site_id, property, value, color_model, has_alpha, alpha_value) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertPair = db.prepare(
    'INSERT INTO contrast_pairs (site_id, element_tag, element_text, fg_declared, bg_declared, fg_composited, bg_composited, naive_cr, extended_cr, aa_naive, aa_extended, is_false_pos, is_false_neg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  var page;
  try {
    page = await browser.newPage();
  } catch (e) {
    db.prepare("UPDATE sites SET status = 'error', error_msg = ? WHERE id = ?").run('newPage failed', siteRow.id);
    console.log('  X ' + siteRow.rank + '. ' + siteRow.domain + ' — Browser error');
    return;
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForTimeout(2000);

    // KEY FIX: pass function reference, not string
    var data = await page.evaluate(extractColors);

    if (!data || !data.declarations || data.declarations.length === 0) {
      db.prepare("UPDATE sites SET status = 'error', error_msg = 'No data extracted' WHERE id = ?").run(siteRow.id);
      console.log('  X ' + siteRow.rank + '. ' + siteRow.domain + ' — No data extracted');
      return;
    }

    for (var i = 0; i < data.declarations.length; i++) {
      var decl = data.declarations[i];
      var cls = classifyColor(decl.value);
      var alpha = null;
      try { alpha = parseColor(decl.value).a; } catch (e) { /* skip */ }
      insertDecl.run(siteRow.id, decl.property, decl.value, cls.model, cls.hasAlpha ? 1 : 0, alpha);
    }

    for (var j = 0; j < data.pairs.length; j++) {
      var pair = data.pairs[j];
      try {
        var ext   = extendedContrastRatio(pair.fg, pair.bg);
        var naive = naiveContrastRatio(pair.fg, pair.bg);
        var aaNaive = naive >= 4.5 ? 1 : 0;
        var aaExt   = ext.aa ? 1 : 0;
        var fp = (aaNaive === 1 && aaExt === 0) ? 1 : 0;
        var fn = (aaNaive === 0 && aaExt === 1) ? 1 : 0;
        var fgC = ext.composited.fg;
        var bgC = ext.composited.bg;
        insertPair.run(
          siteRow.id, pair.tag, pair.text, pair.fg, pair.bg,
          'rgb(' + fgC.r + ',' + fgC.g + ',' + fgC.b + ')',
          'rgb(' + bgC.r + ',' + bgC.g + ',' + bgC.b + ')',
          naive, ext.contrastRatio, aaNaive, aaExt, fp, fn
        );
      } catch (e) { /* skip */ }
    }

    db.prepare("UPDATE sites SET status = 'crawled', crawled_at = datetime('now') WHERE id = ?").run(siteRow.id);
    console.log('  V ' + siteRow.rank + '. ' + siteRow.domain + ' — ' + data.declarations.length + ' colors, ' + data.pairs.length + ' pairs');

  } catch (err) {
    db.prepare("UPDATE sites SET status = 'error', error_msg = ? WHERE id = ?").run(err.message.substring(0, 500), siteRow.id);
    console.log('  X ' + siteRow.rank + '. ' + siteRow.domain + ' — ' + err.message.substring(0, 80));
  } finally {
    try { await page.close(); } catch (e) { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
function runAnalysis(db) {
  console.log('\n' + '='.repeat(60));
  console.log('CRAWL ANALYSIS');
  console.log('='.repeat(60));

  var sitesTotal = db.prepare("SELECT COUNT(*) as n FROM sites WHERE status = 'crawled'").get().n;
  var sitesError = db.prepare("SELECT COUNT(*) as n FROM sites WHERE status = 'error'").get().n;
  console.log('\nSites crawled: ' + sitesTotal + ', errors: ' + sitesError);

  if (sitesTotal === 0) {
    console.log('\nNo sites were successfully crawled.');
    return;
  }

  var declTotal = db.prepare('SELECT COUNT(*) as n FROM color_declarations').get().n;
  var declAlpha = db.prepare('SELECT COUNT(*) as n FROM color_declarations WHERE has_alpha = 1').get().n;
  if (declTotal > 0) {
    console.log('Color declarations: ' + declTotal + ' total, ' + declAlpha + ' with alpha (' + (declAlpha/declTotal*100).toFixed(1) + '%)');
  }

  var byModel = db.prepare('SELECT color_model, COUNT(*) as n FROM color_declarations GROUP BY color_model ORDER BY n DESC').all();
  console.log('\nBy color model:');
  byModel.forEach(function(r) { console.log('  ' + r.color_model.padEnd(10) + ' ' + r.n); });

  var pairsTotal = db.prepare('SELECT COUNT(*) as n FROM contrast_pairs').get().n;
  var pairsFP    = db.prepare('SELECT COUNT(*) as n FROM contrast_pairs WHERE is_false_pos = 1').get().n;
  var pairsFN    = db.prepare('SELECT COUNT(*) as n FROM contrast_pairs WHERE is_false_neg = 1').get().n;
  console.log('\nContrast pairs: ' + pairsTotal);
  if (pairsTotal > 0) {
    console.log('False positives: ' + pairsFP + ' (' + (pairsFP/pairsTotal*100).toFixed(1) + '%)');
    console.log('False negatives: ' + pairsFN + ' (' + (pairsFN/pairsTotal*100).toFixed(1) + '%)');
  }

  var sitesWithAlpha = db.prepare('SELECT COUNT(DISTINCT site_id) as n FROM color_declarations WHERE has_alpha = 1').get().n;
  console.log('\nSites using alpha-bearing colors: ' + sitesWithAlpha + ' / ' + sitesTotal + ' (' + (sitesWithAlpha/sitesTotal*100).toFixed(1) + '%)');

  var worstFP = db.prepare(
    'SELECT fg_declared, bg_declared, naive_cr, extended_cr, element_tag, element_text FROM contrast_pairs WHERE is_false_pos = 1 ORDER BY (naive_cr - extended_cr) DESC LIMIT 10'
  ).all();
  if (worstFP.length > 0) {
    console.log('\nTop 10 worst false positives:');
    worstFP.forEach(function(r, i) {
      console.log('  ' + (i+1) + '. FG: ' + r.fg_declared + ', BG: ' + r.bg_declared);
      console.log('     Naive: ' + r.naive_cr + ':1 -> Extended: ' + r.extended_cr + ':1 (' + r.element_tag + ': "' + r.element_text.substring(0,40) + '")');
    });
  }

  // Export CSV
  var csvPath = path.join(path.dirname(db.name), 'analysis_summary.csv');
  var allPairs = db.prepare(
    'SELECT site_id, element_tag, fg_declared, bg_declared, fg_composited, bg_composited, naive_cr, extended_cr, aa_naive, aa_extended, is_false_pos, is_false_neg FROM contrast_pairs'
  ).all();
  var csvLines = ['site_id,tag,fg_declared,bg_declared,fg_composited,bg_composited,naive_cr,extended_cr,aa_naive,aa_extended,false_pos,false_neg'];
  allPairs.forEach(function(r) {
    csvLines.push(r.site_id + ',' + r.element_tag + ',"' + r.fg_declared + '","' + r.bg_declared + '","' + r.fg_composited + '","' + r.bg_composited + '",' + r.naive_cr + ',' + r.extended_cr + ',' + r.aa_naive + ',' + r.aa_extended + ',' + r.is_false_pos + ',' + r.is_false_neg);
  });
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log('\nCSV exported: ' + csvPath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  var config = parseArgs();
  console.log('\nwcag-alpha-contrast crawler');
  console.log('Sites: ' + config.sites + ', DB: ' + config.db);
  if (config.proxy) console.log('Proxy: ' + config.proxy);
  console.log('');

  var db = initDb(config.db);

  var existingSites = db.prepare('SELECT COUNT(*) as n FROM sites').get().n;
  if (existingSites === 0 || !config.resume) {
    if (existingSites > 0 && !config.resume) {
      db.exec('DELETE FROM contrast_pairs; DELETE FROM color_declarations; DELETE FROM sites;');
    }
    var sites = await loadTrancoList(config.sites);
    var insertSite = db.prepare('INSERT OR IGNORE INTO sites (rank, domain, url) VALUES (?, ?, ?)');
    var insertMany = db.transaction(function(sites) {
      for (var i = 0; i < sites.length; i++) {
        insertSite.run(sites[i].rank, sites[i].domain, 'https://' + sites[i].domain);
      }
    });
    insertMany(sites);
    console.log('Loaded ' + sites.length + ' sites into database.');
  }

  var pending = db.prepare("SELECT * FROM sites WHERE status = 'pending' ORDER BY rank").all();
  console.log('\nCrawling ' + pending.length + ' pending sites...\n');

  var launchOptions = { headless: true };
  if (config.proxy) {
    launchOptions.proxy = { server: config.proxy };
  }

  var browser = await chromium.launch(launchOptions);

  for (var i = 0; i < pending.length; i++) {
    await crawlSite(browser, db, pending[i]);
  }

  await browser.close();
  runAnalysis(db);
  db.close();
  console.log('\nDone.');
}

main().catch(function(err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
