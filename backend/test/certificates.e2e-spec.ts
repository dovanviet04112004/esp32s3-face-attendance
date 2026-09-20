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

const CODE = "E2ECT01";
const OTHER = "E2ECT02";
const EMAIL = "e2ect@kiosk.local";
const OTHER_EMAIL = "e2ect-other@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const PURPOSE = "Vay ngân hàng";

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
  let asked = "";
  let deskViewer: Viewer;

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [CODE, OTHER] } } });
  }

  async function makePerson(code: string, email: string): Promise<number> {
    const made = await db.employee.create({
      data: { code, fullName: `Người ${code}`, active: true, hireDate: new Date("2024-03-01") },
    });
    await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword(PASSWORD),
        role: "EMPLOYEE",
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

    await makePerson(CODE, EMAIL);
    await makePerson(OTHER, OTHER_EMAIL);
    mine = await signIn(EMAIL);
    theirs = await signIn(OTHER_EMAIL);
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
