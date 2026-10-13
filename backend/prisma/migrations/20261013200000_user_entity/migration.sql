-- The entities a desk account answers for; none means the whole group (KEHOACH 9.4).
CREATE TABLE "UserEntity" (
    "userId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,

    CONSTRAINT "UserEntity_pkey" PRIMARY KEY ("userId","legalEntityId")
);

-- CreateIndex
CREATE INDEX "UserEntity_legalEntityId_idx" ON "UserEntity"("legalEntityId");

-- AddForeignKey
ALTER TABLE "UserEntity" ADD CONSTRAINT "UserEntity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEntity" ADD CONSTRAINT "UserEntity_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
