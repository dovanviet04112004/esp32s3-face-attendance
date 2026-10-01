import type { PrismaService } from "../src/database/prisma.service.js";

/** Desk notices sit on seeded logins and cascade nowhere; run while the rows exist. */
export async function clearDeskNotices(db: PrismaService, codes: string[]): Promise<void> {
  const where = { employee: { code: { in: codes } } };
  const [requests, advances, letters, changes, slips, dependents] = await Promise.all([
    db.request.findMany({ where, select: { id: true } }),
    db.salaryAdvance.findMany({ where, select: { id: true } }),
    db.certificate.findMany({ where, select: { id: true } }),
    db.profileChange.findMany({ where, select: { id: true } }),
    db.payslip.findMany({ where, select: { id: true } }),
    db.dependent.findMany({ where, select: { id: true } }),
  ]);
  const ids = (rows: { id: string }[]) => rows.map((one) => one.id);
  await db.notification.deleteMany({
    where: {
      OR: [
        { requestId: { in: ids(requests) } },
        { advanceId: { in: ids(advances) } },
        { certificateId: { in: ids(letters) } },
        { profileChangeId: { in: ids(changes) } },
        { payslipId: { in: ids(slips) } },
        { dependentId: { in: ids(dependents) } },
      ],
    },
  });
}
