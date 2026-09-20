-- CreateTable
CREATE TABLE "PasswordSetup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordSetup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordSetup_tokenHash_key" ON "PasswordSetup"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordSetup_userId_usedAt_idx" ON "PasswordSetup"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "PasswordSetup_expiresAt_idx" ON "PasswordSetup"("expiresAt");

-- AddForeignKey
ALTER TABLE "PasswordSetup" ADD CONSTRAINT "PasswordSetup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
