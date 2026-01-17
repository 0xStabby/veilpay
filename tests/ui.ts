import { assert } from "chai";
import fs from "fs";
import path from "path";

describe("ui scaffold", () => {
  it("contains core sections", () => {
    const html = fs.readFileSync(path.join(process.cwd(), "ui/index.html"), "utf8");
    assert.include(html, "Deposit");
    assert.include(html, "Authorization");
    assert.include(html, "Withdraw");
  });
});
