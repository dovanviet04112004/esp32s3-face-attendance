import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CertificateKind, ProfileField, RequestKind, Role } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { HIT_KINDS, type HitKind } from "../src/modules/search/dto/search.dto.js";
import { localDay } from "../src/modules/timesheet/local-day.js";
import { clearDeskNotices } from "./teardown.js";
import { tokensOf } from "./fixtures.js";

const PASSWORD = "kiosk-e2e-password";
const PAY_YEAR = 1995;
const PAY_MONTH = 3;
const NET = 17_171_717;
const TERM = "xuyen";
const DEVICE = "e2e-gs-door";
const HOME = "E2EGSD1";
const AWAY = "E2EGSD2";
const ASSET = "E2EGS-A1";
const CHAIRS = ["E2EGS-G1", "E2EGS-G2", "E2EGS-G3", "E2EGS-G4", "E2EGS-G5"];
const SIXTH_CHAIR = "E2EGS-G6";
const DOCS = { home: "E2EGS-DOC1", away: "E2EGS-DOC2", retired: "E2EGS-DOC3", all: "E2EGS-DOC4" };
const MAIL = (who: string) => `e2egs-${who}@kiosk.local`;

// Every name holds "Xuyến", so one term reaches all of this suite's rows and nobody else's.
const PEOPLE = {
  boss: { code: "E2EGS01", name: "Nguyễn An Xuyến", dept: HOME, role: "MANAGER" },
  worker: { code: "E2EGS02", name: "Nguyễn Thị Xuyến", dept: HOME, role: "EMPLOYEE" },
  peer: { code: "E2EGS03", name: "Trần Nguyên Xuyến", dept: HOME, role: null },
  stranger: { code: "E2EGS04", name: "Nguyễn Văn Xuyến", dept: AWAY, role: null },
  hr: { code: "E2EGS05", name: "Lê Thị Xuyến", dept: null, role: "HR" },
  payroll: { code: "E2EGS06", name: "Phạm Văn Xuyến", dept: null, role: "PAYROLL" },
  wild: { code: "E2EGS07", name: "Xuyến 7%_Lý", dept: HOME, role: null },
  tame: { code: "E2EGS08", name: "Xuyến 7ab Lý", dept: HOME, role: null },
} as const;
type Person = keyof typeof PEOPLE;
const CODES = Object.values(PEOPLE).map((one) => one.code);

const WHO = ["admin", "hr", "payroll", "manager", "employee", "viewer"] as const;
type Who = (typeof WHO)[number];
const ROLE: Record<Who, Role> = {
  admin: "ADMIN",
  hr: "HR",
  payroll: "PAYROLL",
  manager: "MANAGER",
  employee: "EMPLOYEE",
  viewer: "VIEWER",
};
const RECORD: Record<Who, Person | null> = {
  admin: null,
  hr: "hr",
  payroll: "payroll",
  manager: "boss",
  employee: "worker",
  viewer: null,
};

// frontend/lib/nav.ts and the inbox tabs of frontend/components/nav/waiting-count.ts, mirrored.
const PAGES: [string, Role[] | "record"][] = [
  ["/employees", ["ADMIN", "HR", "PAYROLL", "MANAGER"]],
  ["/org", ["ADMIN", "HR", "MANAGER"]],
  ["/leave", ["ADMIN", "HR", "MANAGER"]],
  ["/approvals", ["ADMIN", "HR", "PAYROLL", "MANAGER"]],
  ["/payroll", ["ADMIN", "HR", "PAYROLL"]],
  ["/assets", ["ADMIN", "HR"]],
  ["/documents", ["ADMIN", "HR"]],
  ["/devices", ["ADMIN"]],
  ["/me", "record"],
];
const TABS: Record<string, Role[]> = {
  requests: ["MANAGER", "ADMIN", "HR", "PAYROLL"],
  disputes: ["ADMIN", "PAYROLL"],
  certificates: ["ADMIN", "HR", "PAYROLL"],
  profileChanges: ["ADMIN", "HR"],
  dependents: ["ADMIN", "PAYROLL"],
  advancesToDecide: ["ADMIN", "HR"],
  advancesToPay: ["ADMIN", "PAYROLL"],
};

interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  detail: string;
  href: string;
  requestKind?: RequestKind;
  certificateKind?: CertificateKind;
  profileField?: ProfileField;
}

interface Reply {
  hits: Hit[];
  more: { kind: HitKind; href: string }[];
}

type Expected = Partial<Record<HitKind, string[]>>;

function opens(who: Who, href: string): boolean {
  const url = new URL(href, "http://kiosk.local");
  const page = PAGES.find(([path]) => url.pathname === path || url.pathname.startsWith(`${path}/`));
  if (!page) {
    return false;
  }
  const [path, roles] = page;
  const allowed = roles === "record" ? RECORD[who] !== null : roles.includes(ROLE[who]);
  const tab = path === "/approvals" ? url.searchParams.get("tab") : null;
  return allowed && (tab === null || (TABS[tab] ?? []).includes(ROLE[who]));
}

function catalogue(lang: "vi" | "en"): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(resolve(process.cwd(), `../frontend/messages/${lang}.json`), "utf8"));
}

describe("the global search box (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  const token = {} as Record<Who, string>;
  const person = {} as Record<Person, number>;
  const ids = {} as Record<string, string>;
  let periodId = "";
  let thisYear = 0;

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, CODES);
    await db.payrollPeriod.deleteMany({ where: { year: PAY_YEAR } });
    await db.user.deleteMany({ where: { email: { in: WHO.map(MAIL) } } });
    await db.document.deleteMany({ where: { code: { in: Object.values(DOCS) } } });
    await db.asset.deleteMany({ where: { code: { in: [ASSET, ...CHAIRS, SIXTH_CHAIR] } } });
    await db.device.deleteMany({ where: { id: DEVICE } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.department.deleteMany({ where: { code: { in: [HOME, AWAY] } } });
  }

  async function find(who: Who, q: string): Promise<Reply> {
    const res = await request(app.getHttpServer())
      .get(`/search?q=${encodeURIComponent(q)}`)
      .set("Authorization", `Bearer ${token[who]}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Reply;
  }

  function of(reply: Reply, kind: HitKind): Hit[] {
    return reply.hits.filter((one) => one.kind === kind);
  }

  function hrefOf(reply: Reply, kind: HitKind, id: string | number): string | undefined {
    return reply.hits.find((one) => one.kind === kind && one.id === String(id))?.href;
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    await sweep();
    thisYear = Number(localDay(new Date(), validateEnv().APP_TIMEZONE).slice(0, 4));

    const entity = await db.legalEntity.findFirstOrThrow({ where: { code: "DEFAULT" } });
    const dept: Record<string, string> = {};
    for (const [code, name] of [
      [HOME, "Phòng Xuyến"],
      [AWAY, "Kho Xuyến"],
    ]) {
      dept[code] = (await db.department.create({ data: { legalEntityId: entity.id, code, name } })).id;
    }
    ids.home = dept[HOME];
    ids.away = dept[AWAY];

    const hash = await hashPassword(PASSWORD);
    let day = 1;
    for (const [key, one] of Object.entries(PEOPLE) as [Person, (typeof PEOPLE)[Person]][]) {
      const made = await db.employee.create({
        data: {
          code: one.code,
          fullName: one.name,
          active: true,
          departmentId: one.dept ? dept[one.dept] : null,
          createdAt: new Date(Date.UTC(2001, 0, day)),
        },
      });
      person[key] = made.id;
      day += 1;
    }
    await db.employee.updateMany({
      where: { id: { in: [person.worker, person.peer] } },
      data: { managerId: person.boss },
    });
    for (const who of WHO) {
      const held = RECORD[who];
      await db.user.create({
        data: { email: MAIL(who), passwordHash: hash, role: ROLE[who], employeeId: held ? person[held] : null },
      });
    }

    const filed = async (key: string, who: Person, kind: RequestKind, from: string, to: string, reason: string) => {
      ids[key] = (
        await db.request.create({
          data: {
            employeeId: person[who],
            kind,
            state: "PENDING",
            fromDate: new Date(from),
            toDate: new Date(to),
            reason,
            createdAt: new Date(Date.UTC(2001, 1, Object.keys(ids).length + 1)),
          },
        })
      ).id;
    };
    await filed("leave", "worker", "LEAVE", "2045-03-23", "2045-03-23", "Khám răng");
    await filed("overtime", "worker", "OVERTIME", "2045-03-10", "2045-03-10", "Kiểm kho cuối quý");
    await filed("fix", "worker", "ATTENDANCE_FIX", "2045-03-11", "2045-03-11", "Quên chấm ra");
    await filed("trip", "worker", "BUSINESS_TRIP", `${thisYear}-09-22`, `${thisYear}-09-24`, "Gặp đối tác");
    await filed("remote", "worker", "REMOTE_WORK", "2045-03-12", "2045-03-12", "Sửa nhà");
    await filed("bossOwn", "boss", "REMOTE_WORK", "2045-03-13", "2045-03-13", "Chờ thợ điện");
    await filed("strangerOvertime", "stranger", "OVERTIME", "2045-03-14", "2045-03-14", "Trực kho");

    const letter = async (key: string, who: Person, kind: CertificateKind, state: "REQUESTED" | "ISSUED") => {
      ids[key] = (await db.certificate.create({ data: { employeeId: person[who], kind, state, purpose: "Vay ngân hàng" } })).id;
    };
    await letter("letterAsked", "worker", "EMPLOYMENT", "REQUESTED");
    await letter("letterIssued", "worker", "INCOME", "ISSUED");
    await letter("strangerAsked", "stranger", "EMPLOYMENT", "REQUESTED");
    await letter("strangerIssued", "stranger", "INCOME", "ISSUED");

    const fields: ProfileField[] = ["PERSONAL_EMAIL", "PHONE", "BANK", "NATIONAL_ID", "TAX_CODE", "SOCIAL_INSURANCE_NO"];
    for (const field of fields) {
      ids[`change${field}`] = (
        await db.profileChange.create({
          data: {
            employeeId: person.worker,
            field,
            newValue: { value: "0900000000" },
            state: field === "PHONE" ? "PENDING" : "APPROVED",
          },
        })
      ).id;
    }
    ids.strangerChange = (
      await db.profileChange.create({
        data: { employeeId: person.stranger, field: "BANK", newValue: { value: "1" }, state: "APPROVED" },
      })
    ).id;

    const policy = await db.payrollPolicy.findFirstOrThrow();
    periodId = (
      await db.payrollPeriod.create({
        data: {
          year: PAY_YEAR,
          month: PAY_MONTH,
          state: "LOCKED",
          startDate: new Date(Date.UTC(PAY_YEAR, PAY_MONTH - 1, 1)),
          endDate: new Date(Date.UTC(PAY_YEAR, PAY_MONTH, 0)),
        },
      })
    ).id;
    const run = await db.payrollRun.create({ data: { periodId, kind: "REGULAR", state: "DONE" } });
    const slip = async (key: string, who: Person, state: "DRAFT" | "ISSUED" | "SENT") => {
      ids[key] = (
        await db.payslip.create({
          data: { runId: run.id, periodId, employeeId: person[who], policyId: policy.id, state, grossPay: NET, netPay: NET },
        })
      ).id;
    };
    await slip("workerSlip", "worker", "ISSUED");
    await slip("strangerSlip", "stranger", "SENT");
    await slip("peerSlip", "peer", "DRAFT");

    const due = new Date(Date.UTC(2045, 0, 1));
    ids.disputeOpen = (
      await db.payslipDispute.create({
        data: { payslipId: ids.workerSlip, employeeId: person.worker, claim: "Thiếu tăng ca", dueAt: due },
      })
    ).id;
    ids.disputeAnswered = (
      await db.payslipDispute.create({
        data: { payslipId: ids.strangerSlip, employeeId: person.stranger, claim: "Sai phụ cấp", dueAt: due, state: "ANSWERED" },
      })
    ).id;

    const month = new Date(Date.UTC(2045, 0, 1));
    ids.dependentPending = (
      await db.dependent.create({ data: { employeeId: person.worker, fullName: "Bé Na", relation: "CHILD", fromMonth: month } })
    ).id;
    ids.dependentActive = (
      await db.dependent.create({
        data: { employeeId: person.stranger, fullName: "Bé Bi", relation: "CHILD", fromMonth: month, state: "ACTIVE" },
      })
    ).id;

    const advance = async (key: string, who: Person, state: "PENDING" | "APPROVED" | "PAID") => {
      ids[key] = (await db.salaryAdvance.create({ data: { employeeId: person[who], amount: 1_000_000, reason: "Sửa xe", state } })).id;
    };
    await advance("advancePending", "worker", "PENDING");
    await advance("advanceApproved", "stranger", "APPROVED");
    await advance("advancePaid", "stranger", "PAID");

    await db.device.create({ data: { id: DEVICE, name: "Cửa Xuyến", location: "Sảnh Bắc", status: "APPROVED" } });
    ids.asset = (await db.asset.create({ data: { code: ASSET, name: "Máy tính Xuyến", kind: "Máy tính", serialNo: "SN-E2EGS-1" } })).id;
    for (const code of CHAIRS) {
      await db.asset.create({ data: { code, name: `Ghế Phòng Đợi ${code}`, kind: "Ghế" } });
    }

    const document = async (key: keyof typeof DOCS, title: string, departmentId: string | null, active: boolean) => {
      ids[`doc_${key}`] = (
        await db.document.create({
          data: { code: DOCS[key], title, departmentId, active, versions: { create: { version: 1, body: "Nội dung" } } },
        })
      ).id;
    };
    await document("home", "Quy định Xuyến", dept[HOME], true);
    await document("away", "Sổ tay Xuyến", dept[AWAY], true);
    await document("retired", "Thông báo Xuyến cũ", null, false);
    await document("all", "Thông báo chung Xuyến", null, true);

    const auth = app.get(AuthService);
    for (const who of WHO) {
      token[who] = tokensOf(await auth.signIn(MAIL(who), PASSWORD, {})).accessToken;
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  function expected(who: Who): Expected {
    const everyone = Object.keys(PEOPLE).map((key) => String(person[key as Person]));
    const requests = ["leave", "overtime", "fix", "trip", "remote", "bossOwn", "strangerOvertime"];
    const own = ["leave", "overtime", "fix", "trip", "remote"];
    const changes = Object.keys(ids).filter((key) => key.startsWith("change"));
    const docs = ["doc_home", "doc_away", "doc_retired", "doc_all"];
    const pick = (keys: string[]) => keys.map((key) => ids[key]);
    const table: Record<Who, Record<string, string[]>> = {
      admin: {
        employee: everyone,
        department: pick(["home", "away"]),
        request: pick(requests),
        certificate: pick(["letterAsked", "strangerAsked"]),
        profileChange: pick(["changePHONE"]),
        dispute: pick(["disputeOpen"]),
        dependent: pick(["dependentPending"]),
        advance: pick(["advancePending", "advanceApproved"]),
        payslip: pick(["workerSlip", "strangerSlip"]),
        kiosk: [DEVICE],
        asset: pick(["asset"]),
        document: pick(docs),
      },
      hr: {
        employee: everyone,
        department: pick(["home", "away"]),
        request: pick(requests),
        certificate: pick(["letterAsked", "strangerAsked"]),
        profileChange: pick(["changePHONE"]),
        advance: pick(["advancePending"]),
        payslip: pick(["workerSlip", "strangerSlip"]),
        asset: pick(["asset"]),
        document: pick(docs),
      },
      payroll: {
        employee: everyone,
        department: pick(["home", "away"]),
        certificate: pick(["letterAsked", "strangerAsked"]),
        dispute: pick(["disputeOpen"]),
        dependent: pick(["dependentPending"]),
        advance: pick(["advanceApproved"]),
        payslip: pick(["workerSlip", "strangerSlip"]),
        document: pick(["doc_all"]),
      },
      manager: {
        employee: [person.boss, person.worker, person.peer].map(String),
        department: pick(["home", "away"]),
        request: pick([...own, "bossOwn"]),
        document: pick(["doc_home", "doc_all"]),
      },
      employee: {
        employee: [String(person.worker)],
        request: pick(own),
        certificate: pick(["letterAsked", "letterIssued"]),
        profileChange: pick(changes),
        dispute: pick(["disputeOpen"]),
        dependent: pick(["dependentPending"]),
        advance: pick(["advancePending"]),
        payslip: pick(["workerSlip"]),
        document: pick(["doc_home", "doc_all"]),
      },
      viewer: {},
    };
    return table[who];
  }

  it("keeps every role inside its own scope for every kind, five at most, and says when there is more", async () => {
    for (const who of WHO) {
      const reply = await find(who, TERM);
      const wanted = expected(who);
      for (const kind of HIT_KINDS) {
        const universe = wanted[kind] ?? [];
        const got = of(reply, kind).map((one) => one.id);
        const leaked = got.filter((id) => !universe.includes(id));
        assert.deepEqual(leaked, [], `${who} got ${kind} rows outside their scope`);
        assert.equal(got.length, Math.min(5, universe.length), `${who} got the wrong number of ${kind} hits`);
        const more = reply.more.some((one) => one.kind === kind);
        assert.ok(!more || universe.length > 5, `${who} got a see-all line for ${kind} with five rows or fewer`);
      }
    }
  });

  it("links every hit and every see-all line to a page the role opens", async () => {
    for (const who of WHO) {
      for (const q of [TERM, `0${PAY_MONTH}/${PAY_YEAR}`, "nghỉ phép", "tạm ứng"]) {
        const reply = await find(who, q);
        for (const href of [...reply.hits.map((one) => one.href), ...reply.more.map((one) => one.href)]) {
          assert.ok(opens(who, href), `${who} was sent to ${href}, a page that role cannot open`);
        }
      }
    }
  });

  it("opens each record itself rather than its list", async () => {
    const worker = await find("employee", TERM);
    assert.equal(hrefOf(worker, "employee", person.worker), "/me");
    assert.equal(hrefOf(worker, "request", ids.leave), `/me/requests?open=${ids.leave}`);
    assert.equal(hrefOf(worker, "certificate", ids.letterAsked), `/me/letters?open=${ids.letterAsked}`);
    assert.equal(hrefOf(worker, "dispute", ids.disputeOpen), `/me/payslips?slip=${ids.workerSlip}`);
    assert.equal(hrefOf(worker, "dependent", ids.dependentPending), "/me/profile#dependants");
    assert.equal(hrefOf(worker, "advance", ids.advancePending), `/me/requests?tab=advances&advance=${ids.advancePending}`);
    assert.equal(hrefOf(worker, "payslip", ids.workerSlip), `/me/payslips?slip=${ids.workerSlip}`);
    assert.equal(hrefOf(worker, "document", ids.doc_home), `/me/documents?doc=${ids.doc_home}`);

    const hr = await find("hr", TERM);
    assert.equal(hrefOf(hr, "department", ids.home), `/org?dept=${ids.home}`);
    assert.equal(hrefOf(hr, "request", ids.strangerOvertime), `/leave/${ids.strangerOvertime}`);
    assert.equal(hrefOf(hr, "certificate", ids.strangerAsked), "/approvals?tab=certificates&q=E2EGS04");
    assert.equal(hrefOf(hr, "advance", ids.advancePending), "/approvals?tab=advancesToDecide&q=E2EGS02");
    assert.equal(hrefOf(hr, "payslip", ids.strangerSlip), `/payroll/${periodId}?q=E2EGS04&open=${ids.strangerSlip}`);
    assert.equal(hrefOf(hr, "asset", ids.asset), `/assets?q=${ASSET}&open=${ids.asset}`);
    assert.equal(hrefOf(hr, "document", ids.doc_retired), `/documents?q=${DOCS.retired}&open=${ids.doc_retired}&retired=1`);

    const payroll = await find("payroll", TERM);
    assert.equal(hrefOf(payroll, "department", ids.home), `/employees?departmentId=${ids.home}`);
    assert.equal(hrefOf(payroll, "advance", ids.advanceApproved), "/approvals?tab=advancesToPay&q=E2EGS04");
    assert.equal(hrefOf(payroll, "dispute", ids.disputeOpen), "/approvals?tab=disputes&q=E2EGS02");
    assert.equal(hrefOf(payroll, "document", ids.doc_all), `/me/documents?doc=${ids.doc_all}`);

    const boss = await find("manager", TERM);
    assert.equal(hrefOf(boss, "request", ids.bossOwn), `/me/requests?open=${ids.bossOwn}`);
    assert.equal(hrefOf(boss, "request", ids.remote), `/leave/${ids.remote}`);
    assert.equal(hrefOf(await find("admin", TERM), "kiosk", DEVICE), `/devices/${DEVICE}`);
  });

  it("names the list behind a see-all line with the term, and draws none where no list takes it", async () => {
    const hr = await find("hr", TERM);
    assert.equal(hr.more.find((one) => one.kind === "employee")?.href, `/employees?q=${TERM}&active=`);
    assert.equal(hr.more.find((one) => one.kind === "request")?.href, `/leave?q=${TERM}`);
    const boss = await find("manager", TERM);
    assert.equal(boss.more.find((one) => one.kind === "request")?.href, `/leave?q=${TERM}`);
    const worker = await find("employee", TERM);
    assert.equal(of(worker, "profileChange").length, 5);
    assert.equal(worker.more.find((one) => one.kind === "profileChange"), undefined, "an own list took no term yet drew a line");
  });

  it("shows see-all only past five", async () => {
    const chairs = "ghe phong doi";
    const five = await find("admin", chairs);
    assert.equal(of(five, "asset").length, 5);
    assert.ok(!five.more.some((one) => one.kind === "asset"), "five chairs drew a see-all line");
    await db.asset.create({ data: { code: SIXTH_CHAIR, name: `Ghế Phòng Đợi ${SIXTH_CHAIR}`, kind: "Ghế" } });
    const six = await find("admin", chairs);
    assert.equal(of(six, "asset").length, 5);
    assert.equal(six.more.find((one) => one.kind === "asset")?.href, `/assets?q=${encodeURIComponent(chairs)}`);
  });

  it("finds an accented name however it is typed", async () => {
    const tree = [person.boss, person.worker, person.peer].map(String).sort();
    for (const typed of ["nguyen", "NGUYEN", "Nguyen", "Nguyễn".normalize("NFD")]) {
      const reply = await find("manager", typed);
      assert.deepEqual(of(reply, "employee").map((one) => one.id).sort(), tree, `"${typed}" missed an accented name`);
    }
    const hr = await find("hr", "nguyen thi xuyen");
    assert.deepEqual(of(hr, "employee").map((one) => one.id), [String(person.worker)]);
  });

  it("finds the same names in the directory and the person picker", async () => {
    const tree = [PEOPLE.boss.code, PEOPLE.worker.code, PEOPLE.peer.code].sort();
    for (const typed of ["nguyen", "NGUYEN", "Nguyen", "Nguyễn".normalize("NFD")]) {
      const res = await request(app.getHttpServer())
        .get(`/employees?active=true&departmentId=${ids.home}&search=${encodeURIComponent(typed)}`)
        .set("Authorization", `Bearer ${token.hr}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const codes = (res.body.rows as { code: string }[]).map((row) => row.code).sort();
      assert.deepEqual(codes, tree, `"${typed}" missed an accented name in the directory`);
    }
  });

  it("ranks a match at the start of a word above one inside it, then the newest", async () => {
    const started = await find("manager", "an");
    assert.deepEqual(
      of(started, "employee").map((one) => one.id),
      [person.boss, person.peer].map(String),
      "Trần Nguyên Xuyến outranked Nguyễn An Xuyến",
    );
    const newest = await find("manager", TERM);
    assert.deepEqual(of(newest, "employee").map((one) => one.id), [person.peer, person.worker, person.boss].map(String));
  });

  it("reads % and _ in a term as themselves", async () => {
    const literal = of(await find("hr", "7%_"), "employee").map((one) => one.id);
    assert.deepEqual(literal, [String(person.wild)], "a typed % or _ matched as a wildcard");
    assert.deepEqual(of(await find("hr", "7_"), "employee"), [], "a typed _ matched any character");
  });

  it("finds requests by day, payslips and periods by month", async () => {
    for (const typed of ["23/03/2045", "2045-03-23"]) {
      const found = of(await find("employee", typed), "request").map((one) => one.id);
      assert.ok(found.includes(ids.leave), `"${typed}" missed the leave on that day`);
    }
    assert.ok(of(await find("employee", "23/09"), "request").some((one) => one.id === ids.trip), "23/09 missed this year's trip");
    for (const typed of [`0${PAY_MONTH}/${PAY_YEAR}`, `${PAY_YEAR}-0${PAY_MONTH}`]) {
      const reply = await find("payroll", typed);
      const slips = of(reply, "payslip").map((one) => one.id);
      assert.ok(slips.includes(ids.workerSlip) && slips.includes(ids.strangerSlip), `"${typed}" missed a payslip`);
      assert.ok(!slips.includes(ids.peerSlip), "a draft payslip reached the search box");
      const period = of(reply, "payrollPeriod").find((one) => one.id === periodId);
      assert.equal(period?.title, `0${PAY_MONTH}/${PAY_YEAR}`);
      assert.equal(period?.href, `/payroll/${periodId}`);
    }
    assert.deepEqual(of(await find("employee", `0${PAY_MONTH}/${PAY_YEAR}`), "payrollPeriod"), [], "a period reached an employee");
  });

  it("matches each kind by the words the catalogues label it with", async () => {
    for (const lang of ["vi", "en"] as const) {
      const words = catalogue(lang);
      for (const kind of ["LEAVE", "OVERTIME", "ATTENDANCE_FIX", "BUSINESS_TRIP", "REMOTE_WORK"] as const) {
        const hits = of(await find("employee", words.requests[`kind${kind}`]), "request");
        assert.ok(hits.some((one) => one.requestKind === kind), `${lang} "${words.requests[`kind${kind}`]}" missed ${kind}`);
      }
      for (const kind of ["EMPLOYMENT", "INCOME"] as const) {
        const hits = of(await find("employee", words.certificates[kind]), "certificate");
        assert.ok(hits.some((one) => one.certificateKind === kind), `${lang} "${words.certificates[kind]}" missed ${kind}`);
      }
      for (const field of ["PERSONAL_EMAIL", "PHONE", "BANK", "NATIONAL_ID", "TAX_CODE", "SOCIAL_INSURANCE_NO"] as const) {
        const hits = of(await find("employee", words.profile[`field${field}`]), "profileChange");
        assert.ok(hits.some((one) => one.profileField === field), `${lang} "${words.profile[`field${field}`]}" missed ${field}`);
      }
      const groups: [HitKind, string][] = [
        ["certificate", words.requests.queueCertificates],
        ["profileChange", words.requests.queueProfile],
        ["dispute", words.requests.queueDisputes],
        ["dependent", words.requests.queueDependents],
        ["advance", words.payroll.advances],
      ];
      for (const [kind, label] of groups) {
        assert.ok(of(await find("employee", label), kind).length > 0, `${lang} "${label}" missed the ${kind} rows`);
      }
    }
  });

  it("gives the pay desk the payslip, never its amount, and never a manager", async () => {
    const desk = await find("payroll", PEOPLE.worker.code);
    const hit = of(desk, "payslip").find((one) => one.id === ids.workerSlip);
    assert.ok(hit, "the pay desk cannot find the payslip");
    assert.ok(!hit.detail.includes(String(NET)) && !hit.title.includes(String(NET)), "the search box showed an amount");
    assert.deepEqual(of(await find("manager", PEOPLE.worker.code), "payslip"), [], "a manager found a report's payslip");
  });

  it("finds a kiosk in the fleet list by its place typed without accents", async () => {
    const res = await request(app.getHttpServer())
      .get("/devices?search=sanh%20bac&take=50")
      .set("Authorization", `Bearer ${token.admin}`);
    assert.equal(res.status, 200);
    assert.ok((res.body.rows as { id: string }[]).some((one) => one.id === DEVICE), "the folded place did not find the kiosk");
  });

  it("refuses a term longer than the box takes", async () => {
    const res = await request(app.getHttpServer())
      .get(`/search?q=${"a".repeat(65)}`)
      .set("Authorization", `Bearer ${token.hr}`);
    assert.equal(res.status, 400);
  });
});
