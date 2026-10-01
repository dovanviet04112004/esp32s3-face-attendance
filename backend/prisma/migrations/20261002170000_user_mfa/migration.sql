-- Two-step sign-in for the desk roles (KEHOACH 9.4): the authenticator sits apart from "User" so no account
-- read pulls a secret along, and a session records when it gave the second factor.
-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "mfaAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UserMfa" (
    "userId" TEXT NOT NULL,
    "secret" BYTEA,
    "pendingSecret" BYTEA,
    "pendingAt" TIMESTAMP(3),
    "enabledAt" TIMESTAMP(3),
    "lastStep" INTEGER,
    "backupCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "misses" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "UserMfa_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserMfa" ADD CONSTRAINT "UserMfa_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

