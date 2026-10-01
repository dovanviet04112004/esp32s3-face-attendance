import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/modules/auth/password.js";

const SPARE_ADMIN = "docs-e2e-admin@kiosk.local";
const ACCOUNTS = { admin: "admin@kiosk.local", hr: "hr@kiosk.local" };
const CALLER_LINE = /^\*\*(Roles: |Caller: |Public: )/;

interface Operation {
  operationId: string;
  description?: string;
}

describe("api reference behind an admin pass (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let auth: AuthService;
  let spareId = "";
  const token: Record<keyof typeof ACCOUNTS, string> = { admin: "", hr: "" };

  async function pass(as: string): Promise<string> {
    const res = await request(http).post("/auth/docs-pass").set("Authorization", `Bearer ${as}`);
    assert.equal(res.status, 201);
    return res.body.pass as string;
  }

  async function open(withPass: string): Promise<string> {
    const res = await request(http).get(`/docs/json?pass=${encodeURIComponent(withPass)}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, "/docs");
    const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((one) => one.startsWith("kiosk_docs="));
    assert.ok(cookie, "the pass set no reference cookie");
    return cookie;
  }

  before(async () => {
    // ConfigModule reads the environment when AppModule is imported, so the mode is set first.
    process.env.API_DOCS = "admin";
    const { AppModule } = await import("../src/app.module.js");
    const password = validateEnv().SEED_ADMIN_PASSWORD ?? "";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const [role, email] of Object.entries(ACCOUNTS)) {
      const res = await request(http).post("/auth/login").send({ email, password });
      assert.equal(res.status, 200, `${role} could not sign in`);
      token[role as keyof typeof ACCOUNTS] = res.body.accessToken;
    }
    await db.user.deleteMany({ where: { email: SPARE_ADMIN } });
    const spare = await db.user.create({
      data: { email: SPARE_ADMIN, passwordHash: await hashPassword("docs-e2e-unused-password"), role: "ADMIN" },
    });
    spareId = spare.id;
  });

  after(async () => {
    await db.user.deleteMany({ where: { email: SPARE_ADMIN } });
    await app.close();
  });

  it("answers as a route that does not exist without a session", async () => {
    for (const path of ["/docs", "/docs/json", "/docs/yaml"]) {
      const res = await request(http).get(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.body.message, "ROUTE_NOT_FOUND", path);
    }
  });

  it("gives a pass to an admin and to nobody else", async () => {
    const refused = await request(http).post("/auth/docs-pass").set("Authorization", `Bearer ${token.hr}`);
    assert.equal(refused.status, 403);
    const given = await request(http).post("/auth/docs-pass").set("Authorization", `Bearer ${token.admin}`);
    assert.equal(given.status, 201);
    assert.equal(typeof given.body.pass, "string");
    assert.equal(given.body.expiresInSeconds, 60);
  });

  it("trades a pass once for a read-only session on the page and its JSON", async () => {
    const once = await pass(token.admin);
    const cookie = await open(once);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/docs/);
    const page = await request(http).get("/docs").set("Cookie", cookie);
    assert.equal(page.status, 200);
    const init = await request(http).get("/docs/swagger-ui-init.js").set("Cookie", cookie);
    assert.equal(init.status, 200);
    assert.match(init.text, /"supportedSubmitMethods":\s*\[\s*\]/);
    const json = await request(http).get("/docs/json").set("Cookie", cookie);
    assert.equal(json.status, 200);
    const again = await request(http).get(`/docs/json?pass=${encodeURIComponent(once)}`);
    assert.equal(again.status, 404, "a spent pass opened the reference again");
  });

  it("names who may call every operation and describes every tag", async () => {
    const cookie = await open(await pass(token.admin));
    const doc = (await request(http).get("/docs/json").set("Cookie", cookie)).body as {
      paths: Record<string, Record<string, Operation>>;
      tags: { name: string; description?: string }[];
    };
    const operations = Object.values(doc.paths).flatMap((item) => Object.values(item));
    const silent = operations.filter((one) => !CALLER_LINE.test(one.description ?? "")).map((one) => one.operationId);
    assert.deepEqual(silent, [], "operations without a caller line");
    assert.match(doc.paths["/auth/docs-pass"].post.description ?? "", /^\*\*Roles: ADMIN\.\*\*/);
    const used = new Set(operations.flatMap((one) => (one as { tags?: string[] }).tags ?? []));
    const described = new Set(doc.tags.filter((tag) => tag.description).map((tag) => tag.name));
    assert.deepEqual([...used].filter((tag) => !described.has(tag)), [], "tags without a description");
  });

  it("ends a session once its holder is no longer an admin", async () => {
    const cookie = await open((await auth.issueDocsPass(spareId)).pass);
    assert.equal((await request(http).get("/docs/json").set("Cookie", cookie)).status, 200);
    await db.user.update({ where: { id: spareId }, data: { role: "HR" } });
    assert.equal((await request(http).get("/docs/json").set("Cookie", cookie)).status, 404);
    const refused = await request(http).get(`/docs/json?pass=${(await auth.issueDocsPass(spareId)).pass}`);
    assert.equal(refused.status, 404, "a pass opened the reference for an account that is not an admin");
  });
});
