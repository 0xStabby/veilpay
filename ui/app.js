const logEl = document.getElementById("log");

const append = (msg) => {
  logEl.textContent = `${logEl.textContent}\n${msg}`.trim();
};

document.getElementById("deposit-form").addEventListener("submit", (e) => {
  e.preventDefault();
  append("Deposit submitted (wire SDK here)");
});

document.getElementById("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const payload = {
    intentHash: form.get("intentHash"),
    payer: form.get("payer"),
    signature: form.get("signature"),
    domain: form.get("domain"),
    mint: "mint-placeholder",
    payeeTagHash: "tag-placeholder",
    amountCiphertext: "cipher-placeholder",
    expirySlot: "0",
    circuitId: 0,
    proofHash: "proof-placeholder",
  };
  try {
    const res = await fetch("/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      append(`Authorization failed: ${data.error || res.statusText}`);
      return;
    }
    append(`Authorization accepted: ${data.id}`);
  } catch (err) {
    append(`Authorization error: ${err.message || err}`);
  }
});

document.getElementById("withdraw-form").addEventListener("submit", (e) => {
  e.preventDefault();
  append("Withdraw submitted (wire SDK here)");
});
