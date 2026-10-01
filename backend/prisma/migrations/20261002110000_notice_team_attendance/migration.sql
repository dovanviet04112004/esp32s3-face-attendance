-- Each manager and the HR desk hold a summary of their people's morning, gone with the day (KEHOACH 9.21.4).
-- New enum values go in a migration of their own; nothing here uses them yet.
ALTER TYPE "NoticeKind" ADD VALUE 'TEAM_ATTENDANCE';
ALTER TYPE "NoticeQueue" ADD VALUE 'TEAM_ATTENDANCE';
ALTER TYPE "NoticeSubject" ADD VALUE 'LOGIN';
