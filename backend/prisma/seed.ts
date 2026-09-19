import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

import { validateEnv } from "../src/config/env.schema.js";

const SEED_ADMIN_EMAIL = "admin@kiosk.local";
const SEED_SHIFT_NAME = "Hành chính";
const SEED_VALID_FROM = new Date("2026-01-01T00:00:00Z");

const env = validateEnv();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

async function main(): Promise<void> {
  // The auth module owns password hashing (E11-T2); a seed that invented its
  // own would be a second scheme to keep in step.
  const admin = await prisma.user.upsert({
    where: { email: SEED_ADMIN_EMAIL },
    update: {},
    create: {
      email: SEED_ADMIN_EMAIL,
      passwordHash: "seed-placeholder-replaced-by-e11-t2",
      role: "ADMIN",
    },
  });

  const shift = await prisma.shift.upsert({
    where: { name: SEED_SHIFT_NAME },
    update: {},
    create: { name: SEED_SHIFT_NAME, startTime: "08:00", endTime: "17:30", graceMinutes: 10 },
  });

  const employee = await prisma.employee.upsert({
    where: { code: "NV0001" },
    update: {},
    create: { code: "NV0001", fullName: "Nguyễn Văn A", department: "Kỹ thuật" },
  });

  await prisma.shiftAssignment.upsert({
    where: {
      shiftId_employeeId_validFrom: {
        shiftId: shift.id,
        employeeId: employee.id,
        validFrom: SEED_VALID_FROM,
      },
    },
    update: {},
    create: { shiftId: shift.id, employeeId: employee.id, validFrom: SEED_VALID_FROM },
  });

  console.log(`seeded admin ${admin.email}, shift ${shift.name}, employee ${employee.code}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
