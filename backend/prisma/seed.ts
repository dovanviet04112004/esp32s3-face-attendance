import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

import { validateEnv } from "../src/config/env.schema.js";
import { hashPassword } from "../src/modules/auth/password.js";

const SEED_ADMIN_EMAIL = "admin@kiosk.local";
const SEED_SHIFT_NAME = "Hành chính";
const SEED_VALID_FROM = new Date("2026-01-01T00:00:00Z");

const env = validateEnv();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

async function main(): Promise<void> {
  if (!env.SEED_ADMIN_PASSWORD) {
    throw new Error("set SEED_ADMIN_PASSWORD before seeding");
  }
  const passwordHash = await hashPassword(env.SEED_ADMIN_PASSWORD);
  const admin = await prisma.user.upsert({
    where: { email: SEED_ADMIN_EMAIL },
    update: { passwordHash },
    create: { email: SEED_ADMIN_EMAIL, passwordHash, role: "ADMIN" },
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
