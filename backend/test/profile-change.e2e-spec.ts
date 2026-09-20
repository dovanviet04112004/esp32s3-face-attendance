import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";

const CODE = "E2EPR01";
const OTHER = "E2EPR02";
const EMAIL = "e2epr@kiosk.local";
const OTHER_EMAIL = "e2epr-other@kiosk.local";
const HR_EMAIL = "e2epr-hr@kiosk.local";
const PERSONAL = "e2epr-personal@kiosk.local";
const MOVED = "e2epr-moved@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const OLD_BANK = "Ngan hang cu";
const OLD_ACCOUNT = "0011001100";
const NEW_BANK = "Ngan hang moi";
const NEW_ACCOUNT = "9988776655";
const LATER_ACCOUNT = "5544332211";
const WIRED_ACCOUNT = "7070707070";
const YEAR = 2033;
const MONTH = 7;
const NET = "12345678";

const MAIL_WAIT_MS = 15000;
const MAIL_POLL_MS = 100;

interface Change {
  id: string;
  field: string;
  state: string;
  noticeTo: string | null;
}

interface Sink {
  waitFor(to: string): Promise<string>;
  close(): Promise<void>;
}

/** A listener where the mailer is already pointed, so the notice is read off
 *  the wire rather than off the row that asked for it.
 */
function smtpSink(port: number): Promise<Sink> {
  const caught: string[] = [];
  const server: Server = createServer((socket) => {
    let seen = "";
    let body = "";
    let inData = false;
    socket.setEncoding("utf8");
    socket.write("220 sink ready\r\n");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      if (inData) {
        body += chunk;
        if (body.includes("\r\n.\r\n")) {
          inData = false;
          caught.push(seen + body);
          socket.write("250 taken\r\n");
        }
        return;
      }
      for (const line of chunk.split("\r\n").filter((one) => one !== "")) {
        seen += `${line}\n`;
        if (/^DATA/i.test(line)) {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (/^QUIT/i.test(line)) {
          socket.write("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  return new Promise((ready) => {
    server.listen(port, "127.0.0.1", () =>
      ready({
        async waitFor(to: string): Promise<string> {
          for (let waited = 0; waited < MAIL_WAIT_MS; waited += MAIL_POLL_MS) {
            const found = caught.find((one) => one.includes(to));
            if (found) {
              return found;
            }
            await sleep(MAIL_POLL_MS);
          }
          throw new Error(`no mail reached ${to} in ${MAIL_WAIT_MS} ms`);
        },
        close: () => new Promise((shut) => server.close(() => shut())),
      }),
    );
  });
}

describe("changing a personal detail through an approval (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let desk = "";
  let hr = "";
  let mine = "";
  let theirs = "";
  let employeeId = 0;
  let otherId = 0;
  let periodId = "";
  let bankChange = "";
  let mailPort = 0;

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL, HR_EMAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [CODE, OTHER] } } });
    await db.payrollPeriod.deleteMany({ where: { year: YEAR } });
  }

  async function makePerson(code: string, email: string, personalEmail?: string): Promise<number> {
    // One statement so no other suite can see an employee with a personal
    // address and no login, which is what provisioning picks up.
    const made = await db.employee.create({
      data: {
        code,
        fullName: `Nguoi ${code}`,
        active: true,
        hireDate: new Date("2024-03-01"),
        personalEmail: personalEmail ?? null,
        bankName: OLD_BANK,
        bankAccount: OLD_ACCOUNT,
        login: { create: { email, passwordHash: await hashPassword(PASSWORD), role: "EMPLOYEE" } },
      },
    });
    return made.id;
  }

  async function signIn(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: PASSWORD });
    assert.equal(res.status, 200, `${email} could not sign in`);
    return res.body.accessToken as string;
  }

  async function held(): Promise<{ bankAccount: string | null; personalEmail: string | null }> {
    return db.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { bankAccount: true, personalEmail: true },
    });
  }

  before(async () => {
    const env = validateEnv();
    mailPort = env.MAIL_PORT;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    desk = signedIn.body.accessToken;

    employeeId = await makePerson(CODE, EMAIL, PERSONAL);
    otherId = await makePerson(OTHER, OTHER_EMAIL);
    await db.user.create({
      data: { email: HR_EMAIL, passwordHash: await hashPassword(PASSWORD), role: "HR" },
    });
    mine = await signIn(EMAIL);
    theirs = await signIn(OTHER_EMAIL);
    hr = await signIn(HR_EMAIL);

    const policy = await db.payrollPolicy.findFirstOrThrow();
    const period = await db.payrollPeriod.create({
      data: {
        year: YEAR,
        month: MONTH,
        startDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)),
        endDate: new Date(Date.UTC(YEAR, MONTH, 0)),
      },
    });
    periodId = period.id;
    const run = await db.payrollRun.create({
      data: { periodId: period.id, kind: "REGULAR", state: "DONE" },
    });
    await db.payslip.create({
      data: {
        runId: run.id,
        periodId: period.id,
        employeeId,
        policyId: policy.id,
        state: "DRAFT",
        grossPay: NET,
        netPay: NET,
      },
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("refuses an account number typed straight into the record", async () => {
    const res = await request(http)
      .patch(`/employees/${employeeId}`)
      .set("Authorization", `Bearer ${desk}`)
      .send({ bankAccount: NEW_ACCOUNT });
    assert.equal(res.status, 400, "the desk changed where the pay goes with one patch");
    assert.equal((await held()).bankAccount, OLD_ACCOUNT);
  });

  it("takes the change as a request and leaves the record alone", async () => {
    const res = await request(http)
      .post("/profile-changes")
      .set("Authorization", `Bearer ${mine}`)
      .send({ field: "BANK", bankName: NEW_BANK, bankAccount: NEW_ACCOUNT });
    assert.equal(res.status, 201);
    const made = res.body as Change;
    assert.equal(made.state, "PENDING");
    assert.equal(made.noticeTo, PERSONAL, "the warning is not addressed to the record's address");
    assert.equal((await held()).bankAccount, OLD_ACCOUNT, "asking alone moved the account");
    bankChange = made.id;
  });

  it("refuses half a bank change", async () => {
    const res = await request(http)
      .post("/profile-changes")
      .set("Authorization", `Bearer ${theirs}`)
      .send({ field: "BANK", bankAccount: NEW_ACCOUNT });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "PROFILE_FIELD_EMPTY");
  });

  it("holds one waiting change per field", async () => {
    const res = await request(http)
      .post("/profile-changes")
      .set("Authorization", `Bearer ${mine}`)
      .send({ field: "BANK", bankName: NEW_BANK, bankAccount: LATER_ACCOUNT });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "PROFILE_CHANGE_PENDING");
  });

  it("keeps the person it is about from approving it", async () => {
    const res = await request(http)
      .post(`/profile-changes/${bankChange}/approve`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "HR_ONLY");
  });

  it("freezes where the money goes when the period locks", async () => {
    const res = await request(http)
      .post(`/payroll-periods/${periodId}/lock`)
      .set("Authorization", `Bearer ${desk}`)
      .send({ acceptOpenItems: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const slip = await db.payslip.findFirstOrThrow({ where: { periodId } });
    assert.equal(slip.bankAccount, OLD_ACCOUNT, "the payslip kept no destination of its own");
  });

  it("writes the record once somebody else approves", async () => {
    const res = await request(http)
      .post(`/profile-changes/${bankChange}/approve`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 201);
    assert.equal((res.body as Change).state, "APPROVED");
    assert.equal((await held()).bankAccount, NEW_ACCOUNT);
  });

  // The figure on the payslip stays right either way; only the person at the
  // other end changes, which is why this is worth its own case.
  it("pays the locked period into the account it locked with", async () => {
    const res = await request(http)
      .get(`/payroll-periods/${periodId}/export?kind=bank`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(OLD_ACCOUNT), "the locked period lost its own destination");
    assert.ok(
      !res.text.includes(NEW_ACCOUNT),
      "a change approved after the lock redirected a payslip already issued",
    );
  });

  it("chooses the warning address when the change is asked for, not when it is answered", async () => {
    const askEmail = await request(http)
      .post("/profile-changes")
      .set("Authorization", `Bearer ${mine}`)
      .send({ field: "PERSONAL_EMAIL", personalEmail: MOVED });
    assert.equal(askEmail.status, 201);
    assert.equal((askEmail.body as Change).noticeTo, PERSONAL);

    const askBank = await request(http)
      .post("/profile-changes")
      .set("Authorization", `Bearer ${mine}`)
      .send({ field: "BANK", bankName: NEW_BANK, bankAccount: LATER_ACCOUNT });
    assert.equal(askBank.status, 201);

    const movedIt = await request(http)
      .post(`/profile-changes/${(askEmail.body as Change).id}/approve`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(movedIt.status, 201);
    assert.equal((await held()).personalEmail, MOVED);

    const paid = await request(http)
      .post(`/profile-changes/${(askBank.body as Change).id}/approve`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(paid.status, 201);
    assert.equal(
      (paid.body as Change).noticeTo,
      PERSONAL,
      "the warning followed the address the same attacker had just moved",
    );
  });

  it("keeps the desk from answering what the desk asked for", async () => {
    const asked = await request(http)
      .post("/profile-changes")
      .set("Authorization", `Bearer ${hr}`)
      .send({ field: "PHONE", phone: "0900000001", employeeId: otherId });
    assert.equal(asked.status, 201);
    const itself = await request(http)
      .post(`/profile-changes/${(asked.body as Change).id}/approve`)
      .set("Authorization", `Bearer ${hr}`);
    assert.equal(itself.status, 403);
    assert.equal(itself.body.message, "PROFILE_SELF_DECIDE");

    const elsewhere = await request(http)
      .post(`/profile-changes/${(asked.body as Change).id}/approve`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(elsewhere.status, 201);
  });

  it("shows one person nothing of another's", async () => {
    const res = await request(http)
      .get("/profile-changes")
      .set("Authorization", `Bearer ${theirs}`);
    assert.equal(res.status, 200);
    const rows = (res.body as { rows: { employeeId: number }[] }).rows;
    assert.ok(rows.length > 0, "the other person cannot see their own change either");
    assert.ok(
      rows.every((row) => row.employeeId === otherId),
      "somebody read a change that is not theirs",
    );
  });

  it("puts the warning on the wire, addressed to the row's own address", async () => {
    const sink = await smtpSink(mailPort);
    try {
      const asked = await request(http)
        .post("/profile-changes")
        .set("Authorization", `Bearer ${mine}`)
        .send({ field: "BANK", bankName: NEW_BANK, bankAccount: WIRED_ACCOUNT });
      assert.equal(asked.status, 201);
      const row = asked.body as Change;
      assert.equal(row.noticeTo, MOVED);
      const given = await request(http)
        .post(`/profile-changes/${row.id}/approve`)
        .set("Authorization", `Bearer ${desk}`);
      assert.equal(given.status, 201);

      const letter = await sink.waitFor(MOVED);
      assert.match(letter, new RegExp(`RCPT TO:\\s*<${MOVED}>`, "i"));
      // Quoted-printable may fold a long line mid-number, so joining first
      // keeps the search from missing what it looks for.
      const plain = letter.replaceAll("=\r\n", "");
      assert.ok(!plain.includes(WIRED_ACCOUNT), "the warning carried the new account number");
      let stamped: Date | null = null;
      for (let waited = 0; waited < MAIL_WAIT_MS && stamped === null; waited += MAIL_POLL_MS) {
        stamped = (await db.profileChange.findUniqueOrThrow({ where: { id: row.id } })).noticeSentAt;
        if (stamped === null) {
          await sleep(MAIL_POLL_MS);
        }
      }
      assert.ok(stamped !== null, "the row does not record that the warning left");
    } finally {
      await sink.close();
    }
  });

  it("files every step under the person it is about", async () => {
    const res = await request(http)
      .get(`/audit?subjectType=employee&subjectId=${employeeId}`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 200);
    const kinds = new Set((res.body.rows as { action: string }[]).map((one) => one.action));
    assert.ok(kinds.has("profile.ask"));
    assert.ok(kinds.has("profile.approve"));
  });
});
