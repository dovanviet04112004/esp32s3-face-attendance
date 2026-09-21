import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateEnv } from "../src/config/env.schema.js";

// Spelled out rather than read from process.env: this suite never loads
// AppModule, which is what puts the dotenv file there for every other one.
const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://kiosk:kiosk@localhost:5432/kiosk",
  REDIS_URL: "redis://localhost:6379",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  DEVICE_BOOTSTRAP_TOKEN: "c".repeat(16),
  JWT_DEVICE_SECRET: "d".repeat(32),
  TEMPLATE_ENCRYPTION_KEY: "e".repeat(44),
  CORS_ORIGIN: "http://localhost:3001",
  APP_PUBLIC_URL: "http://localhost:3001",
  MQTT_URL: "mqtts://localhost:8883",
  MQTT_USERNAME: "api",
  MQTT_PASSWORD: "api",
};

describe("environment (e2e)", () => {
  it("boots without a mail host outside production", () => {
    const env = validateEnv(BASE);
    assert.equal(env.MAIL_HOST, undefined);
  });

  it("refuses to boot in production without a mail host", () => {
    assert.throws(() => validateEnv({ ...BASE, NODE_ENV: "production" }), /MAIL_HOST/);
  });

  it("boots in production once a mail host is set", () => {
    const env = validateEnv({
      ...BASE,
      NODE_ENV: "production",
      MAIL_HOST: "smtp.example.com",
    });
    assert.equal(env.MAIL_HOST, "smtp.example.com");
  });

  it("reads an empty mail host as unset", () => {
    assert.throws(
      () => validateEnv({ ...BASE, NODE_ENV: "production", MAIL_HOST: "" }),
      /MAIL_HOST/,
    );
  });

  it("names every variable it cannot do without", () => {
    const naked = validateEnv;
    assert.throws(() => naked({ NODE_ENV: "test" }), /DATABASE_URL[\s\S]*MQTT_PASSWORD/);
  });
});
