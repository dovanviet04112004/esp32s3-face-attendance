import type { PrismaService } from "../src/database/prisma.service.js";

/** Desk notices sit on seeded logins and cascade nowhere; run while the rows exist. */
export async function clearDeskNotices(db: PrismaService, codes: string[]): Promise<void> {
  const where = { employee: { code: { in: codes } } };
  const [requests, advances] = await Promise.all([
    db.request.findMany({ where, select: { id: true } }),
    db.salaryAdvance.findMany({ where, select: { id: true } }),
  ]);
  await db.notification.deleteMany({
    where: {
      OR: [
        { requestId: { in: requests.map((one) => one.id) } },
        { advanceId: { in: advances.map((one) => one.id) } },
      ],
    },
  });
}
