import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

import { validateEnv } from "../src/config/env.schema.js";
import { hashPassword } from "../src/modules/auth/password.js";

const SEED_ADMIN_EMAIL = "admin@kiosk.local";
// One password for all three: a dev seed, and the roles are what differ.
const SEED_ACCOUNTS = [
  { email: SEED_ADMIN_EMAIL, role: "ADMIN" },
  { email: "hr@kiosk.local", role: "HR" },
  { email: "viewer@kiosk.local", role: "VIEWER" },
] as const;
const SEED_ENTITY_CODE = "DEFAULT";
const SEED_SHIFT_NAME = "Hành chính";
const SEED_VALID_FROM = new Date("2026-01-01T00:00:00Z");
// Figures set by resolution, not by this file: a later one is a new row with a
// later effectiveFrom (KEHOACH 9.7).
const SEED_POLICY = {
  effectiveFrom: SEED_VALID_FROM,
  selfDeduction: 15_500_000,
  dependentDeduction: 6_200_000,
  socialRateBp: 800,
  healthRateBp: 150,
  unemploymentRateBp: 100,
  employerSocialRateBp: 1750,
  employerHealthRateBp: 300,
  employerUnemploymentRateBp: 100,
  referenceWage: 2_340_000,
  socialCapMultiple: 20,
  regionalMinimumWage: 5_310_000,
  unemploymentCapMultiple: 20,
  standardDaysPerMonth: 26,
};
const SEED_BRACKETS = [
  { ordinal: 1, upToAmount: 10_000_000, rateBp: 500 },
  { ordinal: 2, upToAmount: 30_000_000, rateBp: 1500 },
  { ordinal: 3, upToAmount: 60_000_000, rateBp: 2500 },
  { ordinal: 4, upToAmount: 100_000_000, rateBp: 3000 },
  { ordinal: 5, upToAmount: null, rateBp: 3500 },
];

const env = validateEnv();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

async function main(): Promise<void> {
  if (!env.SEED_ADMIN_PASSWORD) {
    throw new Error("set SEED_ADMIN_PASSWORD before seeding");
  }
  const passwordHash = await hashPassword(env.SEED_ADMIN_PASSWORD);
  for (const account of SEED_ACCOUNTS) {
    await prisma.user.upsert({
      where: { email: account.email },
      update: { passwordHash, role: account.role },
      create: { email: account.email, passwordHash, role: account.role },
    });
  }

  const shift = await prisma.shift.upsert({
    where: { name: SEED_SHIFT_NAME },
    update: {},
    create: { name: SEED_SHIFT_NAME, startTime: "08:00", endTime: "17:30", graceMinutes: 10 },
  });

  const entity = await prisma.legalEntity.upsert({
    where: { code: SEED_ENTITY_CODE },
    update: {},
    create: { code: SEED_ENTITY_CODE, name: "Công ty" },
  });

  const department = await prisma.department.upsert({
    where: { legalEntityId_code: { legalEntityId: entity.id, code: "PB0001" } },
    update: {},
    create: { legalEntityId: entity.id, code: "PB0001", name: "Kỹ thuật" },
  });

  const employee = await prisma.employee.upsert({
    where: { code: "NV0001" },
    update: {},
    create: {
      code: "NV0001",
      fullName: "Nguyễn Văn A",
      legalEntityId: entity.id,
      departmentId: department.id,
      hireDate: SEED_VALID_FROM,
    },
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

  const policy = await prisma.payrollPolicy.upsert({
    where: {
      legalEntityId_effectiveFrom: {
        legalEntityId: entity.id,
        effectiveFrom: SEED_POLICY.effectiveFrom,
      },
    },
    update: {},
    create: { ...SEED_POLICY, legalEntityId: entity.id },
  });

  for (const bracket of SEED_BRACKETS) {
    await prisma.taxBracket.upsert({
      where: { policyId_ordinal: { policyId: policy.id, ordinal: bracket.ordinal } },
      update: {},
      create: { ...bracket, policyId: policy.id },
    });
  }

  await prisma.compensationRecord.upsert({
    where: {
      employeeId_effectiveFrom: { employeeId: employee.id, effectiveFrom: SEED_VALID_FROM },
    },
    update: {},
    create: {
      employeeId: employee.id,
      effectiveFrom: SEED_VALID_FROM,
      baseSalary: 20_000_000,
      insuranceSalary: 20_000_000,
      reason: "HIRE",
    },
  });

  const who = SEED_ACCOUNTS.map((a) => a.role).join(", ");
  console.log(`seeded ${who}, shift ${shift.name}, employee ${employee.code}, ${SEED_BRACKETS.length} tax brackets`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
