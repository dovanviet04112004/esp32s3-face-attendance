import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateEnv } from "../src/config/env.schema.js";

function without(key: string): NodeJS.ProcessEnv {
  const copy = { ...process.env };
  delete copy[key];
  return copy;
}

describe("environment (e2e)", () => {
  it("boots without a mail host outside production", () => {
    const env = validateEnv({ ...without("MAIL_HOST"), NODE_ENV: "test" });
    assert.equal(env.MAIL_HOST, undefined);
  });

  it("refuses to boot in production without a mail host", () => {
    assert.throws(
      () => validateEnv({ ...without("MAIL_HOST"), NODE_ENV: "production" }),
      /MAIL_HOST/,
    );
  });

  it("boots in production once a mail host is set", () => {
    const env = validateEnv({
      ...process.env,
      NODE_ENV: "production",
      MAIL_HOST: "smtp.example.com",
    });
    assert.equal(env.MAIL_HOST, "smtp.example.com");
  });

  it("reads an empty mail host as unset", () => {
    assert.throws(
      () => validateEnv({ ...process.env, NODE_ENV: "production", MAIL_HOST: "" }),
      /MAIL_HOST/,
    );
  });
});
