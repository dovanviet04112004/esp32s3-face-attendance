#!/bin/sh
# One sample per table per run, kept as a series so "how much did this grow
# last week" is a question the data can answer (KEHOACH 9.22.5).
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}"

keep_samples="${GROWTH_KEEP_SAMPLES:-104}"

# `ops` is outside what Prisma declares, so migrate diff never asks to drop it.
psql --quiet --command "
    SET client_min_messages = warning;
    CREATE SCHEMA IF NOT EXISTS ops;
    CREATE TABLE IF NOT EXISTS ops.table_growth (
        taken_at    timestamptz NOT NULL DEFAULT now(),
        table_name  text        NOT NULL,
        live_rows   bigint      NOT NULL,
        dead_rows   bigint      NOT NULL,
        total_bytes bigint      NOT NULL,
        index_bytes bigint      NOT NULL,
        PRIMARY KEY (taken_at, table_name)
    );
"

psql --quiet --command "
    INSERT INTO ops.table_growth (table_name, live_rows, dead_rows, total_bytes, index_bytes)
    SELECT relname, n_live_tup, n_dead_tup,
           pg_total_relation_size(relid), pg_indexes_size(relid)
      FROM pg_stat_user_tables
     WHERE schemaname = 'public';
"

# Against the newest sample that is not this one, so a run today compares with
# last week's run rather than with itself.
psql --no-align --field-separator=' ' --command "
    WITH latest AS (SELECT max(taken_at) AS at FROM ops.table_growth),
         earlier AS (
             SELECT max(taken_at) AS at FROM ops.table_growth
              WHERE taken_at < (SELECT at FROM latest)
         )
    SELECT now_.table_name,
           now_.live_rows,
           now_.live_rows - coalesce(was.live_rows, now_.live_rows) AS rows_added,
           pg_size_pretty(now_.total_bytes) AS total,
           pg_size_pretty(now_.total_bytes - coalesce(was.total_bytes, now_.total_bytes)) AS grew,
           round(100.0 * now_.dead_rows / nullif(now_.live_rows + now_.dead_rows, 0), 1) AS dead_pct
      FROM ops.table_growth now_
      LEFT JOIN ops.table_growth was
             ON was.table_name = now_.table_name AND was.taken_at = (SELECT at FROM earlier)
     WHERE now_.taken_at = (SELECT at FROM latest)
     ORDER BY now_.total_bytes DESC
     LIMIT 20;
"

# Two years of weekly samples is enough to see a trend and small enough to
# never need its own retention story.
psql --quiet --command "
    DELETE FROM ops.table_growth
     WHERE taken_at < (
         SELECT min(at) FROM (
             SELECT DISTINCT taken_at AS at FROM ops.table_growth
              ORDER BY taken_at DESC LIMIT ${keep_samples}
         ) kept
     );
"

echo "$(date -u +%FT%TZ) growth sampled, keeping ${keep_samples} samples"
