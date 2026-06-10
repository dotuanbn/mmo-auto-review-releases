#!/usr/bin/env node
/**
 * Diagnostic script: Inspect traffic_campaigns, traffic_logs, settings, and proxies
 * from the live SQLite DB + settings.json that control Traffic Booster / Traffic campaigns.
 *
 * Run: node scripts/inspect-traffic-db.cjs
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Tuan', 'AppData', 'Roaming');
const BASE_DIR = path.join(APPDATA, 'mmo-auto-review');
const DB_PATH = path.join(BASE_DIR, 'data', 'mmo-review.db');
const SETTINGS_JSON_PATH = path.join(BASE_DIR, 'settings.json');
const PROXY_DEBUG_LOG = path.join(BASE_DIR, 'proxy-debug.log');

function safeReadJson(p) {
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {
    return { _error: String(e.message || e) };
  }
  return null;
}

function formatDate(ts) {
  if (!ts) return '—';
  try {
    // timestamps are unix seconds in most columns
    const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return String(ts);
  }
}

function redact(val) {
  if (typeof val !== 'string') return val;
  if (val.length > 8) return val.slice(0, 4) + '***' + val.slice(-4);
  if (val) return '***';
  return '';
}

console.log('============================================================');
console.log('MMO Auto Review — Traffic DB / Settings Inspector');
console.log('============================================================\n');

console.log('Primary DB path     :', DB_PATH);
console.log('DB file exists      :', fs.existsSync(DB_PATH));
if (fs.existsSync(DB_PATH)) {
  const st = fs.statSync(DB_PATH);
  console.log('DB size / mtime     :', (st.size / 1024).toFixed(1) + ' KB,', st.mtime.toISOString());
}
console.log('Settings JSON path  :', SETTINGS_JSON_PATH);
console.log('Settings JSON exists:', fs.existsSync(SETTINGS_JSON_PATH));
console.log('');

// Open read-only to avoid locking a running app
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error('FATAL: Cannot open DB (may be locked or missing):', e.message);
  console.log('Trying to continue with settings.json only...\n');
  db = null;
}

// 1. List tables
if (db) {
  console.log('--- TABLES IN DATABASE ---');
  const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all();
  console.log(tables.map(t => t.name).join(', ') || '(none)');
  console.log('');
}

// 2. traffic_campaigns — full list + focus on Traffic Booster
if (db) {
  console.log('--- 1. TRAFFIC_CAMPAIGNS (all rows, newest first) ---');
  let campaigns = [];
  try {
    campaigns = db.prepare(`
      SELECT id, name, traffic_mode, status,
             threads_count, visits_per_location,
             delay_min_seconds, delay_max_seconds,
             actions_per_visit, fixed_action_count,
             ai_auto_control, target_kpi,
             account_ids, location_ids,
             total_visits, completed_visits, failed_visits, current_round,
             created_at, started_at, completed_at
      FROM traffic_campaigns
      ORDER BY id DESC
    `).all();
  } catch (e) {
    console.log('Query error (traffic_campaigns):', e.message);
    try {
      campaigns = db.prepare('SELECT * FROM traffic_campaigns ORDER BY id DESC').all();
    } catch (e2) {
      console.log('Fallback also failed:', e2.message);
    }
  }

  if (!campaigns.length) {
    console.log('(NO ROWS in traffic_campaigns)');
  } else {
    console.log('Total campaigns:', campaigns.length);
    campaigns.forEach((c, i) => {
      const isBooster = (c.name || '').toLowerCase().includes('booster') ||
                        (c.name || '').toLowerCase().includes('traffic boost');
      const marker = isBooster ? '  <<-- TRAFFIC BOOSTER CANDIDATE' : '';
      console.log(`\n#${c.id} "${c.name}"${marker}`);
      console.log('  status:', c.status, ' | mode:', c.traffic_mode, ' | aiAutoControl:', !!c.ai_auto_control);
      console.log('  threads:', c.threads_count, ' | visitsPerLoc:', c.visits_per_location,
                  ' | delay:', c.delay_min_seconds, '-', c.delay_max_seconds, 's');
      console.log('  actions/visit:', c.actions_per_visit, 'fixedCount:', !!c.fixed_action_count,
                  ' | targetKpi:', c.target_kpi || '(none)');
      console.log('  progress: completed=', c.completed_visits, 'failed=', c.failed_visits,
                  'totalTarget≈', c.total_visits, ' | round:', c.current_round);
      console.log('  accounts(JSON):', c.account_ids);
      console.log('  locations(JSON):', c.location_ids);
      console.log('  created:', formatDate(c.created_at),
                  ' started:', formatDate(c.started_at),
                  ' completed:', formatDate(c.completed_at));
    });
  }
  console.log('');
}

// 3. Latest traffic_logs — errors and warnings first
if (db) {
  console.log('--- 2. LATEST TRAFFIC_LOGS (up to 60, newest first) ---');
  console.log('    (showing error_message / failed status prominently)');
  let logs = [];
  try {
    logs = db.prepare(`
      SELECT
        tl.id, tl.campaign_id, tc.name as campaign_name,
        tl.account_id, tl.location_id,
        tl.status, tl.error_message, tl.round,
        tl.duration, tl.actions, tl.created_at
      FROM traffic_logs tl
      LEFT JOIN traffic_campaigns tc ON tl.campaign_id = tc.id
      ORDER BY tl.created_at DESC, tl.id DESC
      LIMIT 60
    `).all();
  } catch (e) {
    console.log('Query error (traffic_logs):', e.message);
    try {
      logs = db.prepare(`
        SELECT tl.*, tc.name as campaign_name
        FROM traffic_logs tl
        LEFT JOIN traffic_campaigns tc ON tl.campaign_id = tc.id
        ORDER BY tl.created_at DESC, tl.id DESC LIMIT 60
      `).all();
    } catch (e2) {
      console.log('Fallback failed:', e2.message);
    }
  }

  if (!logs.length) {
    console.log('(NO ROWS in traffic_logs)');
  } else {
    const failedOrError = logs.filter(l => l.status !== 'success' || (l.error_message && l.error_message.trim()));
    console.log('Total fetched:', logs.length, ' | with issues (failed or error):', failedOrError.length);

    // Print problematic ones first
    if (failedOrError.length) {
      console.log('\n  !! ROWS WITH ERRORS / FAILURES:');
      failedOrError.slice(0, 30).forEach(l => {
        console.log(`  [${formatDate(l.created_at)}] camp#${l.campaign_id} (${l.campaign_name || '??'}) | status=${l.status} | round=${l.round} | dur=${l.duration}s`);
        if (l.error_message) console.log('     ERROR:', l.error_message);
        if (l.actions) {
          try {
            const acts = JSON.parse(l.actions);
            const errs = acts.filter(a => a && (a.success === false || a.error));
            if (errs.length) console.log('     bad actions:', JSON.stringify(errs.slice(0,3)));
          } catch {}
        }
      });
    }

    console.log('\n  -- Most recent 15 logs (any status) --');
    logs.slice(0, 15).forEach(l => {
      const err = l.error_message ? ' | ERR: ' + String(l.error_message).slice(0, 80) : '';
      let actSummary = '';
      try {
        const acts = JSON.parse(l.actions || '[]');
        actSummary = ' | acts=' + acts.length;
      } catch {}
      console.log(`  [${formatDate(l.created_at)}] #${l.id} camp#${l.campaign_id} loc#${l.location_id} | ${l.status}${err}${actSummary} | r${l.round} ${l.duration}s`);
    });
  }
  console.log('');
}

// 4. DB-level settings table (legacy)
if (db) {
  console.log('--- 3. DB SETTINGS TABLE (key/value — legacy, few rows) ---');
  try {
    const rows = db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all();
    if (!rows.length) console.log('(empty)');
    rows.forEach(r => {
      console.log(`  ${r.key} = ${r.value}  (updated ${formatDate(r.updated_at)})`);
    });
  } catch (e) {
    console.log('Error reading settings table:', e.message);
  }
  console.log('');
}

// 5. Main application settings (JSON) — the ones that actually control proxy/fproxy/traffic
console.log('--- 4. APPLICATION SETTINGS (settings.json) — primary source for runtime ---');
const appSettings = safeReadJson(SETTINGS_JSON_PATH);
if (!appSettings) {
  console.log('(settings.json not found or unreadable)');
} else if (appSettings._error) {
  console.log('Error parsing settings.json:', appSettings._error);
} else {
  const st = fs.statSync(SETTINGS_JSON_PATH);
  console.log('File mtime:', st.mtime.toISOString());

  // Redact secrets
  const display = {
    // Proxy / FProxy critical
    useProxy: appSettings.useProxy,
    rotateProxyPerSession: appSettings.rotateProxyPerSession,
    autoRemoveDeadProxies: appSettings.autoRemoveDeadProxies,
    fproxyApiKey: redact(appSettings.fproxyApiKey),
    fproxyLocation: appSettings.fproxyLocation,

    // Browser / execution
    headless: appSettings.headless,
    hideAutomation: appSettings.hideAutomation,
    maxConcurrentBrowsers: appSettings.maxConcurrentBrowsers,

    // Traffic defaults
    defaultTrafficMode: appSettings.defaultTrafficMode,
    defaultVisitsPerLocation: appSettings.defaultVisitsPerLocation,
    defaultActionsPerVisit: appSettings.defaultActionsPerVisit,
    trafficDelayMin: appSettings.trafficDelayMin,
    trafficDelayMax: appSettings.trafficDelayMax,

    // Runtime policy
    logLevel: appSettings.logLevel,
    ragEnabled: appSettings.ragEnabled,
    captchaMode: appSettings.captchaMode,

    // Other potentially blocking
    dataDir: appSettings.dataDir || '(default)',
  };
  console.dir(display, { depth: 2 });

  // Explicit blocker analysis
  console.log('\n  >>> POTENTIAL EXECUTION BLOCKERS (from settings.json):');
  if (appSettings.useProxy === true && !appSettings.fproxyApiKey) {
    console.log('  [BLOCK?] useProxy=true but fproxyApiKey is empty → FProxy will be cleared at startup.');
  }
  if (appSettings.useProxy === false) {
    console.log('  [INFO] useProxy=false → TrafficBoostEngine will force DIRECT (no proxy) for all visits.');
  }
  if (appSettings.headless === false) {
    console.log('  [INFO] headless=false → browsers will be VISIBLE (good for debugging, slower).');
  }
  if (appSettings.maxConcurrentBrowsers && appSettings.maxConcurrentBrowsers < 1) {
    console.log('  [WARN] maxConcurrentBrowsers low — may limit threads.');
  }
}
console.log('');

// 6. Proxies table summary (important for traffic)
if (db) {
  console.log('--- 5. PROXIES TABLE SUMMARY ---');
  try {
    const total = db.prepare('SELECT COUNT(*) as c FROM proxies').get().c;
    console.log('Total proxies in DB:', total);
    const byStatus = db.prepare('SELECT status, COUNT(*) as c FROM proxies GROUP BY status').all();
    console.log('By status:', byStatus);

    const sample = db.prepare(`
      SELECT id, host, port, provider, status, last_check, response_time
      FROM proxies ORDER BY id DESC LIMIT 8
    `).all();
    if (sample.length) {
      console.log('Recent sample:');
      sample.forEach(p => {
        console.log(`  #${p.id} ${p.host}:${p.port} provider=${p.provider || '—'} status=${p.status} lastCheck=${formatDate(p.last_check)} rt=${p.response_time || '—'}ms`);
      });
    }
  } catch (e) {
    console.log('Proxy query error:', e.message);
  }
  console.log('');
}

// 7. Quick hints from proxy-debug.log (if present)
if (fs.existsSync(PROXY_DEBUG_LOG)) {
  console.log('--- 6. TAIL OF proxy-debug.log (last 15 lines) ---');
  try {
    const content = fs.readFileSync(PROXY_DEBUG_LOG, 'utf8');
    const lines = content.trim().split(/\r?\n/).slice(-15);
    lines.forEach(l => console.log('  ' + l));
  } catch (e) {
    console.log('Could not read proxy-debug.log:', e.message);
  }
  console.log('');
}

// 8. Other potential audit sources in DB
if (db) {
  console.log('--- 7. OTHER AUDIT / ERROR SOURCES (quick counts) ---');
  try {
    const reviewErr = db.prepare("SELECT COUNT(*) as c FROM review_history WHERE status='failed'").get().c;
    console.log('Failed reviews in review_history:', reviewErr);

    const agentErr = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge WHERE success=0 OR error IS NOT NULL").get().c;
    console.log('agent_knowledge failure/error entries:', agentErr);

    const aiErr = db.prepare("SELECT COUNT(*) as c FROM ai_metrics WHERE success=0").get().c;
    console.log('ai_metrics failures:', aiErr);
  } catch (e) {
    console.log('Audit count error (non-fatal):', e.message);
  }
}

if (db) {
  try { db.close(); } catch {}
}

console.log('\n============================================================');
console.log('Inspection complete. Review "POTENTIAL EXECUTION BLOCKERS" above.');
console.log('============================================================');
