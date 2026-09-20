-- Runs once, on an empty data directory. Prisma owns every table, so this file
-- only sets what a migration cannot: database-wide defaults.

-- Timestamps travel as UTC from the kiosk and are compared across devices.
ALTER DATABASE kiosk SET timezone TO 'UTC';

-- citext would let an email match regardless of case, which is how people
-- type one. Prisma cannot create the extension itself.
CREATE EXTENSION IF NOT EXISTS citext;

-- Loaded by shared_preload_libraries, but the view only exists once the
-- extension is created, and it is what makes a slow query visible before a
-- user reports it (KEHOACH 9.22.5).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
