#!/usr/bin/env node
/**
 * Diagnostic script: Dump row counts for all tables related to traffic, reviews, and campaigns.
 * Also inspects `campaigns` (review campaigns) and `traffic_campaigns` for statuses and names.
 *
 * Run:
 *   node scripts/dump-campaign-tables.cjs
 *
 * Optional: override DB path
 *   node scripts/dump-campaign-tables.cjs "C:\path\to\mmo-review.db"
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Tuan', 'AppData', 'Roaming');
const DEFAULT_BASE = path.join(APPDATA, 'mmo-auto-review');
const DEFAULT_DB_PATH = path.join(DEFAULT_BASE, 'data', 'mmo-review.db');

const argPath = process.argv[2];
const DB_PATH = argPath ? path.resolve(argPath) : DEFAULT_DB_PATH;

const TABLES_TO_COUNT = [
  'projects',
  'accounts',
  'proxies',
  'locations',
  'campaigns',
  'review_history',
  'campaign_schedules',
  'traffic_tasks',
  'traffic_campaigns',
  'traffic_logs',
  'review_templates',
  'agent_knowledge',
  'automation_scripts',
  'ai_metrics',
  'analytics_snapshots',
  'image_folders',
  'settings',
];

const KNOWN_CAMPAIGN_STATUSES = new Set(['pending', 'running', 'paused', 'done', 'error']);
const KNOWN_TRAFFIC_STATUSES = new Set(['pending', 'running', 'paused', 'completed', 'stopped']);

function formatDate(ts) {
  if (!ts && ts !== 0) return '—';
  try {
    const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return String(ts);
  }
}

function printSection(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

console.log('MMO Auto Review — Campaign / Traffic Tables Dump');
console.log('DB path :', DB_PATH);
console.log('Exists  :', fs.existsSync(DB_PATH));
if (fs.existsSync(DB_PATH)) {
  const st = fs.statSync(DB_PATH);
  console.log('Size    :', (st.size / 1024).toFixed(1) + ' KB');
  console.log('Mtime   :', st.mtime.toISOString());
}
console.log('');

let db = null;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  console.log('[OK] Opened database read-only\n');
} catch (e) {
  console.error('[FATAL] Cannot open DB read-only:', e.message);
  console.error('        (App may be running and has an exclusive lock, or file is missing/corrupt.)');
  process.exit(1);
}

// 1. Row counts for relevant tables
printSection('ROW COUNTS — Traffic / Review / Campaign Tables');

for (const table of TABLES_TO_COUNT) {
  try {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
    console.log(String(table).padEnd(22) + ': ' + row.count);
  } catch (e) {
    console.log(String(table).padEnd(22) + ': (table missing or error) ' + e.message);
  }
}

// 2. campaigns (review campaigns) — statuses and names
printSection('CAMPAIGNS TABLE (Review Campaigns)');

try {
  // By status
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM campaigns GROUP BY status ORDER BY count DESC').all();
  console.log('By status:');
  byStatus.forEach(r => {
    const unusual = !KNOWN_CAMPAIGN_STATUSES.has(r.status) ? '  << UNUSUAL STATUS' : '';
    console.log(`  ${String(r.status || '(null)').padEnd(12)} : ${r.count}${unusual}`);
  });

  // All rows (key fields)
  const rows = db.prepare(`
    SELECT id, name, status, progress, total_reviews, success_reviews, failed_reviews,
           created_at, project_id
    FROM campaigns
    ORDER BY id DESC
  `).all();

  console.log(`\nTotal rows: ${rows.length}`);
  if (rows.length > 0) {
    console.log('\nAll campaigns (newest first):');
    rows.forEach(c => {
      const unusual = !KNOWN_CAMPAIGN_STATUSES.has(c.status) ? '  [UNUSUAL]' : '';
      console.log(`  #${c.id}  name="${c.name}"${unusual}`);
      console.log(`      status=${c.status}  progress=${c.progress}%  reviews=${c.total_reviews} (ok=${c.success_reviews}, fail=${c.failed_reviews})`);
      console.log(`      project_id=${c.project_id ?? '—'}  created=${formatDate(c.created_at)}`);
    });
  } else {
    console.log('(NO ROWS in campaigns)');
  }

  // Distinct names (in case many similar)
  const names = db.prepare('SELECT DISTINCT name FROM campaigns ORDER BY name').all();
  if (names.length > 0) {
    console.log('\nDistinct names:');
    names.forEach(n => console.log('  - ' + (n.name || '(empty)')));
  }
} catch (e) {
  console.log('Error querying campaigns table:', e.message);
}

// 3. traffic_campaigns — statuses and names
printSection('TRAFFIC_CAMPAIGNS TABLE (Traffic / Map Campaigns)');

try {
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM traffic_campaigns GROUP BY status ORDER BY count DESC').all();
  console.log('By status:');
  byStatus.forEach(r => {
    const unusual = !KNOWN_TRAFFIC_STATUSES.has(r.status) ? '  << UNUSUAL STATUS' : '';
    console.log(`  ${String(r.status || '(null)').padEnd(12)} : ${r.count}${unusual}`);
  });

  const rows = db.prepare(`
    SELECT id, name, status, traffic_mode, total_visits, completed_visits, failed_visits,
           current_round, threads_count, visits_per_location,
           created_at, started_at, completed_at, project_id
    FROM traffic_campaigns
    ORDER BY id DESC
  `).all();

  console.log(`\nTotal rows: ${rows.length}`);
  if (rows.length > 0) {
    console.log('\nAll traffic campaigns (newest first):');
    rows.forEach(c => {
      const unusual = !KNOWN_TRAFFIC_STATUSES.has(c.status) ? '  [UNUSUAL]' : '';
      console.log(`  #${c.id}  name="${c.name}"${unusual}`);
      console.log(`      status=${c.status}  mode=${c.traffic_mode}  round=${c.current_round}`);
      console.log(`      visits: target≈${c.total_visits}  done=${c.completed_visits}  fail=${c.failed_visits}`);
      console.log(`      threads=${c.threads_count}  perLoc=${c.visits_per_location}`);
      console.log(`      project_id=${c.project_id ?? '—'}  created=${formatDate(c.created_at)}  started=${formatDate(c.started_at)}`);
    });
  } else {
    console.log('(NO ROWS in traffic_campaigns)');
  }

  const names = db.prepare('SELECT DISTINCT name FROM traffic_campaigns ORDER BY name').all();
  if (names.length > 0) {
    console.log('\nDistinct names:');
    names.forEach(n => console.log('  - ' + (n.name || '(empty)')));
  }
} catch (e) {
  console.log('Error querying traffic_campaigns table:', e.message);
}

// 4. Quick cross-check: any campaigns referencing projects?
printSection('QUICK CROSS-CHECKS');

try {
  const projCount = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
  console.log('projects total:', projCount);

  const campWithProj = db.prepare('SELECT COUNT(*) as c FROM campaigns WHERE project_id IS NOT NULL').get().c;
  console.log('campaigns with project_id:', campWithProj);

  const tcWithProj = db.prepare('SELECT COUNT(*) as c FROM traffic_campaigns WHERE project_id IS NOT NULL').get().c;
  console.log('traffic_campaigns with project_id:', tcWithProj);

  // Locations / accounts / proxies by status (useful context)
  const locByStatus = db.prepare('SELECT status, COUNT(*) as c FROM locations GROUP BY status').all();
  console.log('locations by status:', locByStatus.map(r => `${r.status}:${r.c}`).join('  '));

  const accByStatus = db.prepare('SELECT status, COUNT(*) as c FROM accounts GROUP BY status').all();
  console.log('accounts by status :', accByStatus.map(r => `${r.status}:${r.c}`).join('  '));

  const proxByStatus = db.prepare('SELECT status, COUNT(*) as c FROM proxies GROUP BY status').all();
  console.log('proxies by status  :', proxByStatus.map(r => `${r.status}:${r.c}`).join('  '));
} catch (e) {
  console.log('Cross-check error (non-fatal):', e.message);
}

try { db.close(); } catch {}

console.log('\nDone.\n');