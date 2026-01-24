import { assert } from "chai";
import request from "supertest";
import { app } from "../relayer/src/app";

describe("relayer api", () => {
  it("responds to health", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.isTrue(Boolean(res.body.ok));
  });
});
