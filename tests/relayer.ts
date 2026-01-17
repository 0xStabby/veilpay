import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import request from "supertest";
import { app } from "../relayer/src/app";
import nacl from "tweetnacl";

describe("relayer api", () => {
  it("accepts valid intent", async () => {
    const payer = Keypair.generate();
    const intentHash = Buffer.alloc(32, 4);
    const domain = "VeilPay:v1:program_id:localnet";
    const message = Buffer.concat([Buffer.from(domain), intentHash]);
    const signature = nacl.sign.detached(message, payer.secretKey);
    const res = await request(app)
      .post("/intent")
      .send({
        intentHash: intentHash.toString("base64"),
        mint: "mint",
        payeeTagHash: "tag",
        amountCiphertext: "cipher",
        expirySlot: "0",
        circuitId: 0,
        proofHash: "proof",
        payer: payer.publicKey.toBase58(),
        signature: Buffer.from(signature).toString("base64"),
        domain,
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, intentHash.toString("base64"));
  });

  it("rejects invalid intent", async () => {
    const res = await request(app).post("/intent").send({});
    assert.equal(res.status, 400);
  });

  it("rejects bad signature", async () => {
    const payer = Keypair.generate();
    const intentHash = Buffer.alloc(32, 8);
    const domain = "VeilPay:v1:program_id:localnet";
    const badSignature = Buffer.alloc(64, 1);
    const res = await request(app)
      .post("/intent")
      .send({
        intentHash: intentHash.toString("base64"),
        mint: "mint",
        payeeTagHash: "tag",
        amountCiphertext: "cipher",
        expirySlot: "0",
        circuitId: 0,
        proofHash: "proof",
        payer: payer.publicKey.toBase58(),
        signature: badSignature.toString("base64"),
        domain,
      });
    assert.equal(res.status, 401);
  });
});
