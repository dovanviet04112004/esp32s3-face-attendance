import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { CertificatesService } from "../src/modules/certificates/certificates.service.js";
import type { Viewer } from "../src/common/scope/viewer.js";
import { clearDeskNotices } from "./teardown.js";

const CODE = "E2ECT01";
const OTHER = "E2ECT02";
const BOSS = "E2ECT03";
const CLERK = "E2ECT04";
const EMAIL = "e2ect@kiosk.local";
const OTHER_EMAIL = "e2ect-other@kiosk.local";
const BOSS_EMAIL = "e2ect-boss@kiosk.local";
const CLERK_EMAIL = "e2ect-clerk@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const PURPOSE = "Vay ngân hàng";
const PAY_YEAR = 1996;

interface Letter {
  id: string;
  kind: string;
  state: string;
  serial: string | null;
}

describe("letters of employment and income (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let desk = "";
  let mine = "";
  let theirs = "";
  let boss = "";
  let clerk = "";
  let asked = "";
  let deskViewer: Viewer;

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, [CODE, OTHER, BOSS, CLERK]);
    await db.payrollPeriod.deleteMany({ where: { year: PAY_YEAR } });
    await db.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL, BOSS_EMAIL, CLERK_EMAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [CODE, OTHER, BOSS, CLERK] } } });
  }

  async function makePerson(code: string, email: string, role: "EMPLOYEE" | "MANAGER" | "HR" = "EMPLOYEE"): Promise<number> {
    const made = await db.employee.create({
      data: { code, fullName: `Người ${code}`, active: true, hireDate: new Date("2024-03-01") },
    });
    await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword(PASSWORD),
        role,
        employeeId: made.id,
      },
    });
    return made.id;
  }

  async function signIn(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: PASSWORD });
    assert.equal(res.status, 200, `${email} could not sign in`);
    return res.body.accessToken as string;
  }

  before(async () => {
    const env = validateEnv();
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
    const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@kiosk.local" } });
    deskViewer = { userId: admin.id, role: "ADMIN", employeeId: admin.employeeId };

    const mineId = await makePerson(CODE, EMAIL);
    await makePerson(OTHER, OTHER_EMAIL);
    const bossId = await makePerson(BOSS, BOSS_EMAIL, "MANAGER");
    await db.employee.update({ where: { id: mineId }, data: { managerId: bossId } });
    await makePerson(CLERK, CLERK_EMAIL, "HR");
    mine = await signIn(EMAIL);
    theirs = await signIn(OTHER_EMAIL);
    boss = await signIn(BOSS_EMAIL);
    clerk = await signIn(CLERK_EMAIL);
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("lets somebody ask for their own letter", async () => {
    const res = await request(http)
      .post("/certificates")
      .set("Authorization", `Bearer ${mine}`)
      .send({ kind: "EMPLOYMENT", purpose: PURPOSE });
    assert.equal(res.status, 201);
    const made = res.body as Letter;
    assert.equal(made.state, "REQUESTED");
    assert.equal(made.serial, null, "a letter nobody has issued already has a number");
    asked = made.id;
  });

  it("gives no letter before it is issued", async () => {
    const res = await request(http)
      .get(`/certificates/${asked}/letter`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "CERTIFICATE_NOT_ISSUED");
  });

  it("keeps an employee from issuing their own", async () => {
    const res = await request(http)
      .post(`/certificates/${asked}/issue`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "HR_ONLY");
  });

  it("issues it with a number the database minted", async () => {
    const res = await request(http)
      .post(`/certificates/${asked}/issue`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 201);
    const given = res.body as Letter;
    assert.equal(given.state, "ISSUED");
    assert.match(given.serial ?? "", /^\d{4}\/\d{5}$/, "the serial is not year over a number");
  });

  it("writes the letter with what the record says", async () => {
    const res = await request(http)
      .get(`/certificates/${asked}/letter`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 200);
    const letter = res.body as { serial: string; text: string };
    assert.ok(letter.text.includes("GIẤY XÁC NHẬN CÔNG TÁC"));
    assert.ok(letter.text.includes(CODE), "the letter does not name the employee");
    assert.ok(letter.text.includes(letter.serial), "the letter does not carry its own number");
    assert.ok(letter.text.includes(PURPOSE), "the letter does not say what it is for");
  });

  it("refuses to answer the same request twice", async () => {
    const res = await request(http)
      .post(`/certificates/${asked}/issue`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "CERTIFICATE_ALREADY_DECIDED");
  });

  it("gives each letter its own number", async () => {
    const serials: string[] = [];
    for (let at = 0; at < 3; at += 1) {
      const ask = await request(http)
        .post("/certificates")
        .set("Authorization", `Bearer ${mine}`)
        .send({ kind: "INCOME", purpose: PURPOSE, months: 2 });
      assert.equal(ask.status, 201);
      const given = await request(http)
        .post(`/certificates/${(ask.body as Letter).id}/issue`)
        .set("Authorization", `Bearer ${desk}`);
      assert.equal(given.status, 201);
      serials.push((given.body as Letter).serial ?? "");
    }
    assert.equal(new Set(serials).size, serials.length, "two letters share a number");
  });

  // Sequentially, a row count looks like a sequence. Only issuing at the same
  // moment tells them apart (KEHOACH 9.23 rule 2).
  it("gives each letter its own number when several are issued at once", async () => {
    const AT_ONCE = 8;
    // Only the issuing has to race; asking one at a time keeps the http side
    // out of the measurement.
    const waiting: string[] = [];
    for (let at = 0; at < AT_ONCE; at += 1) {
      const ask = await request(http)
        .post("/certificates")
        .set("Authorization", `Bearer ${mine}`)
        .send({ kind: "EMPLOYMENT", purpose: PURPOSE });
      assert.equal(ask.status, 201);
      waiting.push((ask.body as Letter).id);
    }
    // Straight at the service: supertest opens a server per call, and eight at
    // once resets connections while no serial has been minted yet.
    const given = await Promise.all(
      waiting.map((id) => app.get(CertificatesService).issue(deskViewer, id)),
    );
    const serials = given.map((one) => one.serial ?? "");
    assert.equal(
      new Set(serials).size,
      AT_ONCE,
      `two of ${AT_ONCE} letters issued together share a number: ${serials.join(", ")}`,
    );
  });

  it("keeps one person's letter out of another's hands", async () => {
    const res = await request(http)
      .get(`/certificates/${asked}/letter`)
      .set("Authorization", `Bearer ${theirs}`);
    assert.equal(res.status, 404, "somebody read a letter that is not theirs");
  });

  it("shows an employee only their own list", async () => {
    const res = await request(http)
      .get("/certificates")
      .set("Authorization", `Bearer ${theirs}`);
    assert.equal(res.status, 200);
    assert.equal((res.body as { rows: Letter[] }).rows.length, 0);
  });

  // The self service page asks for its own list, and the desk sees everybody,
  // so the filter has to survive the scope clause beside it.
  it("narrows the list to one person when asked, even for an unscoped viewer", async () => {
    const employee = await db.employee.findUniqueOrThrow({ where: { code: CODE } });
    // A second person has to own a letter, or every row matches whatever the
    // filter says and the assertion cannot fail.
    const theirLetter = await request(http)
      .post("/certificates")
      .set("Authorization", `Bearer ${theirs}`)
      .send({ kind: "EMPLOYMENT", purpose: PURPOSE });
    assert.equal(theirLetter.status, 201);

    const whole = await request(http).get("/certificates").set("Authorization", `Bearer ${desk}`);
    assert.equal(whole.status, 200);
    assert.ok(
      (whole.body as { rows: { employeeId: number }[] }).rows.some(
        (row) => row.employeeId !== employee.id,
      ),
      "the desk list holds only one person, so the filter proves nothing",
    );
    const narrowed = await request(http)
      .get(`/certificates?employeeId=${employee.id}`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(narrowed.status, 200);
    const rows = (narrowed.body as { rows: { employeeId: number }[] }).rows;
    assert.ok(rows.length > 0, "the person this suite made has no letters");
    assert.ok(
      rows.every((row) => row.employeeId === employee.id),
      "the filter was dropped and the whole scope came back",
    );
    assert.ok(
      (whole.body as { rows: unknown[] }).rows.length >= rows.length,
      "the unfiltered list is somehow smaller than the filtered one",
    );
  });

  it("keeps a manager's tree away from a letter that carries pay and papers", async () => {
    const letter = await request(http)
      .get(`/certificates/${asked}/letter`)
      .set("Authorization", `Bearer ${boss}`);
    assert.equal(letter.status, 404, "a manager read a subordinate's letter");
    const listed = await request(http).get("/certificates").set("Authorization", `Bearer ${boss}`);
    assert.equal(listed.status, 200);
    assert.equal((listed.body as { rows: Letter[] }).rows.length, 0, "a manager lists a subordinate's letters");
  });

  it("tells the desk a letter is waiting, and the asker when it is decided", async () => {
    const told = await db.notification.count({ where: { kind: "REQUEST_WAITING", certificateId: asked } });
    assert.ok(told > 0, "nobody on the desk was told a letter is waiting");
    const decided = await db.notification.findMany({
      where: { kind: "REQUEST_DECIDED", certificateId: asked },
      select: { approved: true, user: { select: { email: true } } },
    });
    assert.deepEqual(decided.map((one) => [one.user.email, one.approved]), [[EMAIL, true]]);
  });

  it("keeps the desk's own letter out of the queue it decides, and out of its hands", async () => {
    const own = await request(http)
      .post("/certificates")
      .set("Authorization", `Bearer ${clerk}`)
      .send({ kind: "EMPLOYMENT", purpose: PURPOSE });
    assert.equal(own.status, 201);
    const ownId = (own.body as Letter).id;
    const clerkId = (await db.employee.findUniqueOrThrow({ where: { code: CLERK } })).id;
    const queue = await request(http)
      .get(`/certificates?state=REQUESTED&search=${CLERK}`)
      .set("Authorization", `Bearer ${clerk}`);
    assert.equal(queue.status, 200);
    assert.equal((queue.body as { rows: Letter[] }).rows.length, 0, "the desk sees its own letter waiting");
    const mineOnly = await request(http)
      .get(`/certificates?state=REQUESTED&employeeId=${clerkId}`)
      .set("Authorization", `Bearer ${clerk}`);
    assert.ok((mineOnly.body as { rows: Letter[] }).rows.some((row) => row.id === ownId), "asking for one's own letters hides them");
    const self = await request(http)
      .post(`/certificates/${ownId}/issue`)
      .set("Authorization", `Bearer ${clerk}`);
    assert.equal(self.status, 403);
    assert.equal(self.body.message, "SELF_DECISION");
  });

  it("lists income from issued monthly payslips only, opened ones included", async () => {
    const employee = await db.employee.findUniqueOrThrow({ where: { code: CODE } });
    const policy = await db.payrollPolicy.findFirstOrThrow();
    const slipFor = async (month: number, kind: "REGULAR" | "BONUS", state: "ISSUED" | "VIEWED", net: number) => {
      const period =
        (await db.payrollPeriod.findFirst({ where: { year: PAY_YEAR, month } })) ??
        (await db.payrollPeriod.create({
          data: {
            year: PAY_YEAR,
            month,
            startDate: new Date(Date.UTC(PAY_YEAR, month - 1, 1)),
            endDate: new Date(Date.UTC(PAY_YEAR, month, 0)),
          },
        }));
      const run = await db.payrollRun.create({ data: { periodId: period.id, kind, state: "DONE" } });
      await db.payslip.create({
        data: { runId: run.id, periodId: period.id, employeeId: employee.id, policyId: policy.id, state, grossPay: net, netPay: net },
      });
    };
    await slipFor(1, "REGULAR", "ISSUED", 11_111_111);
    await slipFor(2, "REGULAR", "VIEWED", 22_222_222);
    await slipFor(2, "BONUS", "ISSUED", 99_999_999);
    const ask = await request(http)
      .post("/certificates")
      .set("Authorization", `Bearer ${mine}`)
      .send({ kind: "INCOME", purpose: PURPOSE, months: 2 });
    assert.equal(ask.status, 201);
    const issued = await request(http)
      .post(`/certificates/${(ask.body as Letter).id}/issue`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(issued.status, 201);
    const letter = await request(http)
      .get(`/certificates/${(ask.body as Letter).id}/letter`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(letter.status, 200);
    const text = (letter.body as { text: string }).text;
    assert.ok(text.includes("22222222"), "a payslip the person opened dropped out of the letter");
    assert.ok(text.includes("11111111"));
    assert.ok(!text.includes("99999999"), "a bonus run was counted as monthly income");
  });

  it("files every step under the person it is about", async () => {
    const employee = await db.employee.findUniqueOrThrow({ where: { code: CODE } });
    const res = await request(http)
      .get(`/audit?subjectType=employee&subjectId=${employee.id}`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 200);
    const kinds = new Set((res.body.rows as { action: string }[]).map((one) => one.action));
    assert.ok(kinds.has("certificate.ask"));
    assert.ok(kinds.has("certificate.issue"));
    assert.ok(kinds.has("certificate.read"), "reading somebody's pay left no trace");
  });
});
