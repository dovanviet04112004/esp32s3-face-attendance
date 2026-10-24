-- AlterTable
ALTER TABLE "Dependent" ADD COLUMN     "askedById" TEXT;

-- AddForeignKey
ALTER TABLE "Dependent" ADD CONSTRAINT "Dependent_askedById_fkey" FOREIGN KEY ("askedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
