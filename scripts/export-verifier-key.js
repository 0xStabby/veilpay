const fs = require('fs');

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error('Usage: node export-verifier-key.js <verification_key.json> <out.json>');
  process.exit(1);
}

const vkey = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const toHex32 = (value) => {
  const hex = BigInt(value).toString(16).padStart(64, '0');
  return hex;
};

const g1ToHex = (g1) => {
  const x = toHex32(g1[0]);
  const y = toHex32(g1[1]);
  return `${x}${y}`;
};

const g2ToHex = (g2) => {
  // snarkjs verification_key.json stores G2 as [[x2,x1],[y2,y1],[1,0]].
  // solana-bn254 expects (c1, c0) for each Fq2 element, so we keep the order.
  const xIm = toHex32(g2[0][0]);
  const xRe = toHex32(g2[0][1]);
  const yIm = toHex32(g2[1][0]);
  const yRe = toHex32(g2[1][1]);
  return `${xIm}${xRe}${yIm}${yRe}`;
};

const out = {
  alpha_g1: g1ToHex(vkey.vk_alpha_1),
  beta_g2: g2ToHex(vkey.vk_beta_2),
  gamma_g2: g2ToHex(vkey.vk_gamma_2),
  delta_g2: g2ToHex(vkey.vk_delta_2),
  gamma_abc: vkey.IC.map((entry) => g1ToHex(entry)),
};

fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outputPath}`);
