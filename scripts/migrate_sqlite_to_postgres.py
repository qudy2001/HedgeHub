#!/usr/bin/env python3

import argparse
import csv
import io
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path


DEFAULT_TABLES = [
    "users",
    "user_sessions",
    "strategy_profiles",
    "strategy_watchlist",
    "setup_watchlist",
    "strategy_runs",
    "paper_orders",
    "paper_order_snapshots",
    "paper_calculator_snapshots",
    "market_snapshots",
    "macro_dashboard_snapshots",
    "strategy_asset_mappings",
    "delta_hedge_scanner_symbols",
]


def build_database_url():
    if os.getenv("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    return "postgresql://{user}:{password}@{host}:{port}/{db}".format(
        user=os.getenv("POSTGRES_USER", "postgres"),
        password=os.getenv("POSTGRES_PASSWORD", "postgres"),
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=os.getenv("POSTGRES_PORT", "5432"),
        db=os.getenv("POSTGRES_DB", "optionsdb"),
    )


def run_psql(database_url, sql, stdin_text=None):
    process = subprocess.run(
        ["psql", "-X", "-v", "ON_ERROR_STOP=1", database_url, "-c", sql],
        input=stdin_text,
        text=True,
        capture_output=True,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or process.stdout.strip() or "psql failed")
    return process.stdout


def get_postgres_columns(database_url, table_name):
    sql = f"""
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '{table_name}'
    ORDER BY ordinal_position;
    """
    output = subprocess.run(
        ["psql", "-X", "-A", "-t", database_url, "-c", sql],
        text=True,
        capture_output=True,
    )
    if output.returncode != 0:
        raise RuntimeError(output.stderr.strip() or output.stdout.strip() or f"Unable to inspect {table_name}")
    return [line.strip() for line in output.stdout.splitlines() if line.strip()]


def export_rows_as_csv(cursor, columns, table_name, batch_size, skipped_log):
    while True:
        rows = cursor.fetchmany(batch_size)
        if not rows:
            return None

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        for row in rows:
            values = []
            try:
                for column in columns:
                    value = row[column]
                    if isinstance(value, bytes):
                        raise TypeError("BLOB values are not supported by this migrator")
                    if value is None:
                        value = r"\N"
                    values.append(value)
                writer.writerow(values)
            except Exception as exc:
                skipped_log.write(
                    json.dumps(
                        {
                            "table": table_name,
                            "rowid": row["rowid"],
                            "error": str(exc),
                        }
                    )
                    + "\n"
                )
        return buffer.getvalue()


def migrate_table(sqlite_conn, database_url, table_name, batch_size, state):
    sqlite_columns = [row["name"] for row in sqlite_conn.execute(f'PRAGMA table_info("{table_name}")')]
    postgres_columns = get_postgres_columns(database_url, table_name)

    if not postgres_columns:
        print(f"[SKIP] {table_name}: not present in PostgreSQL schema")
        return

    common_columns = [column for column in sqlite_columns if column in postgres_columns]
    if not common_columns:
        print(f"[SKIP] {table_name}: no common columns")
        return

    print(f"[MIGRATE] {table_name}: columns={','.join(common_columns)}")
    sqlite_conn.row_factory = sqlite3.Row
    selected_columns = ", ".join([f'"{column}"' for column in common_columns])
    cursor = sqlite_conn.execute(f'SELECT rowid, {selected_columns} FROM "{table_name}"')

    skipped_path = Path("logs") / f"{table_name}.skipped.jsonl"
    skipped_path.parent.mkdir(parents=True, exist_ok=True)

    run_psql(database_url, f'TRUNCATE TABLE "{table_name}" RESTART IDENTITY CASCADE;')

    with skipped_path.open("a", encoding="utf-8") as skipped_log:
        while True:
            csv_payload = export_rows_as_csv(cursor, common_columns, table_name, batch_size, skipped_log)
            if csv_payload is None:
                break
            copy_sql = (
                f'\\copy "{table_name}" ({", ".join(common_columns)}) '
                r"FROM STDIN WITH (FORMAT csv, NULL '\N')"
            )
            process = subprocess.run(
                ["psql", "-X", "-v", "ON_ERROR_STOP=1", database_url, "-c", copy_sql],
                input=csv_payload,
                text=True,
                capture_output=True,
            )
            if process.returncode != 0:
                raise RuntimeError(
                    f"Copy failed for {table_name}: {process.stderr.strip() or process.stdout.strip()}"
                )

    state[table_name] = {"completed": True, "columns": common_columns}


def main():
    parser = argparse.ArgumentParser(description="Migrate HedgeHub SQLite data into PostgreSQL.")
    parser.add_argument("--sqlite-path", default=os.getenv("SQLITE_DB_PATH", "./data/hedgehub.db"))
    parser.add_argument("--database-url", default=build_database_url())
    parser.add_argument("--batch-size", type=int, default=2000)
    parser.add_argument("--tables", nargs="*", default=DEFAULT_TABLES)
    parser.add_argument("--state-file", default="./logs/sqlite_to_postgres_state.json")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    if not Path(args.sqlite_path).exists():
        print(f"SQLite database not found: {args.sqlite_path}", file=sys.stderr)
        sys.exit(1)

    state_path = Path(args.state_file)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state = {}
    if args.resume and state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))

    sqlite_conn = sqlite3.connect(args.sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row

    try:
        for table_name in args.tables:
            if args.resume and state.get(table_name, {}).get("completed"):
                print(f"[RESUME] skipping completed table {table_name}")
                continue
            migrate_table(sqlite_conn, args.database_url, table_name, args.batch_size, state)
            state_path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    finally:
        sqlite_conn.close()

    print("Migration completed.")


if __name__ == "__main__":
    main()
