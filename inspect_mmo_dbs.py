#!/usr/bin/env python3
"""
MMO Auto Review DB Inspector
- Inspects the primary mmo-review.db (traffic_campaigns + campaigns)
- Discovers and inspects other .db / .sqlite files in workspace and mmo-related AppData folders
- Uses read-only connections to avoid locking a running app
"""
import sqlite3
from pathlib import Path
from datetime import datetime
import sys

TARGET_DB = r"C:\Users\Tuan\AppData\Roaming\mmo-auto-review\data\mmo-review.db"
WORKSPACE_ROOT = r"E:\New folder\Kiwi-Project-MMO\mmo-auto-review"

FOCUS_TABLES = ("traffic_campaigns", "campaigns")


def get_file_info(path: Path):
    try:
        stat = path.stat()
        return {
            "size": stat.st_size,
            "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception as e:
        return {"error": str(e)}


def inspect_db(db_path: Path, focus_tables=FOCUS_TABLES):
    info = get_file_info(db_path)
    print("\n" + "=" * 90)
    print(f"DB FILE: {db_path}")
    print(f"  Size: {info.get('size', '?')} bytes   | LastWrite: {info.get('mtime', '?')}")

    conn = None
    try:
        # Read-only URI connection (important if the Electron app has the DB open)
        uri = f"file:{db_path.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=8.0)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # Discover tables
        cur.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;")
        objects = [(r[0], "table" if True else "view") for r in cur.fetchall()]  # simplify
        # Better: separate tables
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
        tables = [r[0] for r in cur.fetchall()]
        print(f"  Tables ({len(tables)}): {tables}")

        if not tables:
            print("  (No tables found - possibly empty or non-SQLite file)")
            return

        # Row counts for every table
        print("  Row counts:")
        for tbl in tables:
            try:
                cur.execute(f'SELECT COUNT(*) FROM "{tbl}"')
                cnt = cur.fetchone()[0]
                print(f"    - {tbl}: {cnt}")
            except Exception as e:
                print(f"    - {tbl}: COUNT ERROR -> {e}")

        # === Focus tables: schema + ALL records ===
        for tbl in focus_tables:
            if tbl not in tables:
                print(f"\n  [{tbl}]  --> TABLE NOT PRESENT")
                continue

            print(f"\n  >>> {tbl} - SCHEMA + ALL RECORDS <<<")
            try:
                cur.execute(f'PRAGMA table_info("{tbl}")')
                pragma = cur.fetchall()
                cols = [p[1] for p in pragma]
                col_types = {p[1]: p[2] for p in pragma}
                print(f"  Columns: {cols}")
                print(f"  Types  : {col_types}")

                cur.execute(f'SELECT * FROM "{tbl}"')
                rows = cur.fetchall()
                print(f"  TOTAL ROWS: {len(rows)}")

                if rows:
                    for idx, row in enumerate(rows):
                        as_dict = {key: row[key] for key in row.keys()}
                        print(f"  [{idx:03d}] {as_dict}")
                else:
                    print("  (table is empty)")
            except Exception as e:
                print(f"  ERROR reading {tbl}: {type(e).__name__}: {e}")

    except sqlite3.OperationalError as e:
        msg = str(e)
        if "locked" in msg.lower() or "database is locked" in msg.lower():
            print(f"  LOCKED (app probably running): {e}")
        else:
            print(f"  SQLITE OPERATIONAL ERROR: {e}")
    except sqlite3.DatabaseError as e:
        print(f"  NOT A VALID SQLITE DB (or corrupted): {e}")
    except Exception as e:
        print(f"  UNEXPECTED ERROR: {type(e).__name__}: {e}")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def find_dbs_under(roots):
    found = set()
    for root_str in roots:
        root = Path(root_str)
        if not root.exists():
            continue
        for pattern in ("**/*.db", "**/*.sqlite", "**/*.sqlite3"):
            for p in root.glob(pattern):
                if p.is_file():
                    found.add(p.resolve())
    return sorted(found)


def main():
    print("=== MMO Auto Review - Database Inspector ===")
    print(f"Python: {sys.version.split()[0]}")
    print(f"Target (primary): {TARGET_DB}")
    print(f"Workspace     : {WORKSPACE_ROOT}")
    print()

    # 1. Always process the exact requested target first
    target_path = Path(TARGET_DB)
    candidates = []

    if target_path.exists():
        candidates.append(target_path.resolve())
    else:
        print(f"[WARN] Primary target does not exist: {TARGET_DB}")

    # 2. Search key locations for any other DBs
    search_roots = [
        r"C:\Users\Tuan\AppData\Roaming\mmo-auto-review",
        r"C:\Users\Tuan\AppData\Roaming\MMO Auto Review",
        WORKSPACE_ROOT,
    ]
    discovered = find_dbs_under(search_roots)

    # Merge, keep target first
    target_resolved = target_path.resolve() if target_path.exists() else None
    for d in discovered:
        if d not in candidates:
            candidates.append(d)

    # Also explicitly add the "MMO Auto Review" (spaced) primary if present and different
    old_primary = Path(r"C:\Users\Tuan\AppData\Roaming\MMO Auto Review\data\mmo-review.db")
    if old_primary.exists():
        old_res = old_primary.resolve()
        if old_res not in candidates:
            # insert after main target if possible
            if target_resolved and target_resolved in candidates:
                idx = candidates.index(target_resolved) + 1
                candidates.insert(idx, old_res)
            else:
                candidates.insert(0, old_res)

    print(f"Discovered {len(candidates)} candidate database file(s) (mmo-related + workspace output copies).")
    print()

    inspected = 0
    for dbp in candidates:
        # For huge non-MMO DBs (e.g. conversation logs), just mention them briefly
        name_lower = dbp.name.lower()
        path_str = str(dbp).lower()
        is_mmo = "mmo" in path_str or "review" in path_str or name_lower == "mmo-review.db"
        size = dbp.stat().st_size if dbp.exists() else 0

        if not is_mmo and size > 300_000:
            print(f"\n[SKIPPED - large unrelated] {dbp} ({size} bytes)")
            continue

        inspect_db(dbp)
        inspected += 1

    print("\n" + "=" * 90)
    print(f"Inspection complete. Processed {inspected} database file(s).")
    print("Note: Read-only mode was used. If a DB was in use by the app, some queries may have been limited.")


if __name__ == "__main__":
    main()
