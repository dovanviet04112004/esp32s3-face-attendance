-- CreateTable
CREATE TABLE "PasswordAlarm" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordAlarm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordAlarm_tokenHash_key" ON "PasswordAlarm"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordAlarm_userId_usedAt_idx" ON "PasswordAlarm"("userId", "usedAt");

-- AddForeignKey
ALTER TABLE "PasswordAlarm" ADD CONSTRAINT "PasswordAlarm_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

