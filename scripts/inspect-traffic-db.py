#!/usr/bin/env python3
"""
Diagnostic script (Python stdlib only): Inspect traffic_campaigns, traffic_logs,
DB settings table, and cross-check with settings.json + proxy-debug.log.

This bypasses any Node/Electron native module version mismatches.

Run:
  python scripts/inspect-traffic-db.py
  # or
  py scripts/inspect-traffic-db.py
"""

import sqlite3
import json
import os
import sys
from datetime import datetime
from pathlib import Path

APPDATA = os.environ.get('APPDATA') or str(Path.home() / 'AppData' / 'Roaming')
BASE = Path(APPDATA) / 'mmo-auto-review'
DB_PATH = BASE / 'data' / 'mmo-review.db'
SETTINGS_JSON = BASE / 'settings.json'
PROXY_DEBUG = BASE / 'proxy-debug.log'

def fmt_ts(ts):
    if ts is None:
        return '—'
    try:
        if isinstance(ts, (int, float)) and ts < 10_000_000_000:  # unix seconds
            return datetime.fromtimestamp(ts).isoformat(sep=' ', timespec='seconds')
        return str(ts)
    except Exception:
        return str(ts)

def redact(s):
    if not isinstance(s, str) or not s:
        return s or ''
    return (s[:4] + '***' + s[-4:]) if len(s) > 8 else '***'

def load_json(p: Path):
    try:
        if p.exists():
            return json.loads(p.read_text(encoding='utf-8'))
    except Exception as e:
        return {'_error': str(e)}
    return None

print('=' * 60)
print('MMO Auto Review — Traffic DB / Settings Inspector (Python)')
print('=' * 60)
print()
print('Primary DB path     :', DB_PATH)
print('DB exists           :', DB_PATH.exists())
if DB_PATH.exists():
    st = DB_PATH.stat()
    print('DB size / mtime     :', f'{st.st_size/1024:.1f} KB,', datetime.fromtimestamp(st.st_mtime).isoformat())
print('Settings JSON       :', SETTINGS_JSON)
print('Settings JSON exists:', SETTINGS_JSON.exists())
print()

conn = None
if DB_PATH.exists():
    try:
        conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        print('[OK] Opened DB read-only\n')
    except Exception as e:
        print('[ERROR] Could not open DB read-only:', e)
        print('        (App may have it locked without WAL; continuing with settings only)\n')
else:
    print('[WARN] DB file missing — only settings.json will be shown.\n')

# 1. Tables
if conn:
    print('--- TABLES ---')
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    names = [r[0] for r in cur.fetchall()]
    print(', '.join(names) or '(none)')
    print()

# 2. traffic_campaigns
if conn:
    print('--- 1. TRAFFIC_CAMPAIGNS (all, newest id first) ---')
    try:
        rows = conn.execute('''
            SELECT id, name, traffic_mode, status,
                   threads_count, visits_per_location,
                   delay_min_seconds, delay_max_seconds,
                   actions_per_visit, fixed_action_count,
                   ai_auto_control, target_kpi,
                   account_ids, location_ids,
                   total_visits, completed_visits, failed_visits, current_round,
                   created_at, started_at, completed_at
            FROM traffic_campaigns ORDER BY id DESC
        ''').fetchall()
    except Exception as e:
        print('Query failed, falling back to SELECT * :', e)
        rows = conn.execute('SELECT * FROM traffic_campaigns ORDER BY id DESC').fetchall()

    if not rows:
        print('(NO ROWS)')
    else:
        print('Total campaigns:', len(rows))
        for r in rows:
            r = dict(r)
            name_l = (r.get('name') or '').lower()
            is_booster = 'booster' in name_l or 'traffic boost' in name_l or 'trafficbooster' in name_l
            marker = '  <<-- "Traffic Booster" / booster candidate' if is_booster else ''
            print(f"\n#{r.get('id')} \"{r.get('name')}\"{marker}")
            print(f"  status={r.get('status')}  mode={r.get('traffic_mode')}  ai_auto_control={bool(r.get('ai_auto_control'))}")
            print(f"  threads={r.get('threads_count')}  visits_per_loc={r.get('visits_per_location')}  "
                  f"delay={r.get('delay_min_seconds')}-{r.get('delay_max_seconds')}s  actions/visit={r.get('actions_per_visit')}")
            print(f"  fixed_action_count={bool(r.get('fixed_action_count'))}  target_kpi={r.get('target_kpi') or '(none)'}")
            print(f"  progress: completed={r.get('completed_visits')} failed={r.get('failed_visits')} total≈{r.get('total_visits')}  round={r.get('current_round')}")
            print('  account_ids:', r.get('account_ids'))
            print('  location_ids:', r.get('location_ids'))
            print(f"  created={fmt_ts(r.get('created_at'))}  started={fmt_ts(r.get('started_at'))}  completed={fmt_ts(r.get('completed_at'))}")
    print()

# 3. traffic_logs — latest + errors
if conn:
    print('--- 2. LATEST TRAFFIC_LOGS (up to 60 newest) ---')
    print('    (errors/failed highlighted)')
    try:
        logs = conn.execute('''
            SELECT tl.id, tl.campaign_id, tc.name AS campaign_name,
                   tl.status, tl.error_message, tl.round, tl.duration,
                   tl.actions, tl.created_at
            FROM traffic_logs tl
            LEFT JOIN traffic_campaigns tc ON tl.campaign_id = tc.id
            ORDER BY tl.created_at DESC, tl.id DESC
            LIMIT 60
        ''').fetchall()
    except Exception as e:
        print('Joined query failed, raw fallback:', e)
        logs = conn.execute('''
            SELECT tl.*, tc.name AS campaign_name
            FROM traffic_logs tl
            LEFT JOIN traffic_campaigns tc ON tl.campaign_id = tc.id
            ORDER BY tl.created_at DESC, tl.id DESC LIMIT 60
        ''').fetchall()

    if not logs:
        print('(NO ROWS in traffic_logs)')
    else:
        logs = [dict(l) for l in logs]
        bad = [l for l in logs if (l.get('status') != 'success') or (l.get('error_message') and str(l.get('error_message')).strip())]
        print(f'Total fetched: {len(logs)}  | issues (non-success or error_message): {len(bad)}')

        if bad:
            print('\n  !! ROWS WITH ERRORS/FAILURES:')
            for l in bad[:30]:
                print(f"  [{fmt_ts(l.get('created_at'))}] camp#{l.get('campaign_id')} ({l.get('campaign_name') or '??'}) | status={l.get('status')} round={l.get('round')} dur={l.get('duration')}s")
                if l.get('error_message'):
                    print('     ERROR:', l.get('error_message'))
                acts = l.get('actions')
                if acts:
                    try:
                        arr = json.loads(acts) if isinstance(acts, str) else acts
                        errs = [a for a in arr if isinstance(a, dict) and (a.get('success') is False or a.get('error'))]
                        if errs:
                            print('     bad actions sample:', json.dumps(errs[:3], ensure_ascii=False)[:300])
                    except Exception:
                        pass

        print('\n  -- Latest 15 (any status) --')
        for l in logs[:15]:
            err = (' | ERR: ' + str(l.get('error_message'))[:80]) if l.get('error_message') else ''
            act_cnt = ''
            try:
                arr = json.loads(l.get('actions') or '[]') if isinstance(l.get('actions'), (str, bytes)) else (l.get('actions') or [])
                act_cnt = f' | acts={len(arr)}'
            except Exception:
                pass
            print(f"  [{fmt_ts(l.get('created_at'))}] #{l.get('id')} camp#{l.get('campaign_id')} | {l.get('status')}{err}{act_cnt} r{l.get('round')} {l.get('duration')}s")
    print()

# 4. DB settings table (legacy)
if conn:
    print('--- 3. DB settings TABLE (legacy key/value) ---')
    try:
        rows = conn.execute('SELECT key, value, updated_at FROM settings ORDER BY key').fetchall()
        if not rows:
            print('(empty)')
        for r in rows:
            r = dict(r)
            print(f"  {r.get('key')} = {r.get('value')}   (updated {fmt_ts(r.get('updated_at'))})")
    except Exception as e:
        print('Error:', e)
    print()

if conn:
    try:
        conn.close()
    except Exception:
        pass

# 5. Primary runtime settings.json (the one that actually drives proxy/fproxy/traffic)
print('--- 4. APPLICATION SETTINGS.JSON (PRIMARY RUNTIME CONFIG) ---')
s = load_json(SETTINGS_JSON)
if not s:
    print('(missing or unreadable)')
elif s.get('_error'):
    print('Parse error:', s['_error'])
else:
    st = SETTINGS_JSON.stat()
    print('File mtime:', datetime.fromtimestamp(st.st_mtime).isoformat())

    disp = {
        'useProxy': s.get('useProxy'),
        'rotateProxyPerSession': s.get('rotateProxyPerSession'),
        'autoRemoveDeadProxies': s.get('autoRemoveDeadProxies'),
        'fproxyApiKey': redact(s.get('fproxyApiKey')),
        'fproxyLocation': s.get('fproxyLocation'),
        'headless': s.get('headless'),
        'hideAutomation': s.get('hideAutomation'),
        'maxConcurrentBrowsers': s.get('maxConcurrentBrowsers'),
        'defaultTrafficMode': s.get('defaultTrafficMode'),
        'defaultVisitsPerLocation': s.get('defaultVisitsPerLocation'),
        'defaultActionsPerVisit': s.get('defaultActionsPerVisit'),
        'trafficDelayMin': s.get('trafficDelayMin'),
        'trafficDelayMax': s.get('trafficDelayMax'),
        'logLevel': s.get('logLevel'),
        'ragEnabled': s.get('ragEnabled'),
        'captchaMode': s.get('captchaMode'),
        'dataDir': s.get('dataDir') or '(default)',
    }
    print(json.dumps(disp, indent=2, ensure_ascii=False))

    print('\n  >>> POTENTIAL EXECUTION BLOCKERS (from settings.json):')
    if s.get('useProxy') is True and not s.get('fproxyApiKey'):
        print('  [BLOCK?] useProxy=true but fproxyApiKey empty → FProxyService will clear config.')
    if s.get('useProxy') is False:
        print('  [INFO] useProxy=false → TrafficBoostEngine forces DIRECT (no proxy) for visits. See TrafficBoostEngine + BrowserService.')
    if s.get('headless') is False:
        print('  [INFO] headless=false → visible browsers (debug friendly, uses more resources).')
    if (s.get('maxConcurrentBrowsers') or 0) < 1:
        print('  [WARN] maxConcurrentBrowsers < 1 — threads will be limited.')
print()

# 6. Proxies table
if conn is None and DB_PATH.exists():
    # reopen briefly
    try:
        conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True, timeout=3)
        conn.row_factory = sqlite3.Row
    except Exception:
        conn = None

if conn:
    print('--- 5. PROXIES TABLE ---')
    try:
        total = conn.execute('SELECT COUNT(*) FROM proxies').fetchone()[0]
        print('Total proxies:', total)
        by = conn.execute('SELECT status, COUNT(*) c FROM proxies GROUP BY status').fetchall()
        print('By status:', [dict(x) for x in by])
        sample = conn.execute('''
            SELECT id, host, port, provider, status, last_check, response_time
            FROM proxies ORDER BY id DESC LIMIT 8
        ''').fetchall()
        if sample:
            print('Recent sample:')
            for p in sample:
                p = dict(p)
                print(f"  #{p.get('id')} {p.get('host')}:{p.get('port')} provider={p.get('provider') or '—'} "
                      f"status={p.get('status')} last={fmt_ts(p.get('last_check'))} rt={p.get('response_time') or '—'}ms")
    except Exception as e:
        print('Proxy query error:', e)
    print()

# 7. proxy-debug.log tail
if PROXY_DEBUG.exists():
    print('--- 6. proxy-debug.log (tail ~20 lines) ---')
    try:
        lines = PROXY_DEBUG.read_text(encoding='utf-8', errors='replace').strip().splitlines()[-20:]
        for ln in lines:
            print('  ' + ln)
    except Exception as e:
        print('Read error:', e)
    print()

# 8. Other error counts
if conn:
    print('--- 7. OTHER AUDIT COUNTS ---')
    try:
        print('review_history failed:', conn.execute("SELECT COUNT(*) FROM review_history WHERE status='failed'").fetchone()[0])
        print('agent_knowledge (success=0 or error not null):', conn.execute("SELECT COUNT(*) FROM agent_knowledge WHERE success=0 OR error IS NOT NULL").fetchone()[0])
        print('ai_metrics failures:', conn.execute("SELECT COUNT(*) FROM ai_metrics WHERE success=0").fetchone()[0])
    except Exception as e:
        print('Audit counts error (non-fatal):', e)

if conn:
    try:
        conn.close()
    except Exception:
        pass

print()
print('=' * 60)
print('Inspection complete. Check the "POTENTIAL EXECUTION BLOCKERS" section.')
print('=' * 60)
