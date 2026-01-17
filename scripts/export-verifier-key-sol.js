const fs = require('fs');

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error('Usage: node export-verifier-key-sol.js <Verifier.sol> <out.json>');
  process.exit(1);
}

const source = fs.readFileSync(inputPath, 'utf8');

const getConst = (name) => {
  const match = source.match(new RegExp(`\\b${name}\\b\\s*=\\s*(\\d+)`));
  if (!match) {
    throw new Error(`Missing constant ${name}`);
  }
  return BigInt(match[1]);
};

const toHex32 = (value) => value.toString(16).padStart(64, '0');

const alphaX = getConst('alphax');
const alphaY = getConst('alphay');
const betaX1 = getConst('betax1');
const betaX2 = getConst('betax2');
const betaY1 = getConst('betay1');
const betaY2 = getConst('betay2');
const gammaX1 = getConst('gammax1');
const gammaX2 = getConst('gammax2');
const gammaY1 = getConst('gammay1');
const gammaY2 = getConst('gammay2');
const deltaX1 = getConst('deltax1');
const deltaX2 = getConst('deltax2');
const deltaY1 = getConst('deltay1');
const deltaY2 = getConst('deltay2');

const icMap = new Map();
for (const match of source.matchAll(/\bIC(\d+)(x|y)\s*=\s*(\d+)/g)) {
  const index = Number(match[1]);
  const coord = match[2];
  const value = BigInt(match[3]);
  const entry = icMap.get(index) || { x: null, y: null };
  entry[coord] = value;
  icMap.set(index, entry);
}

const icKeys = [...icMap.keys()].sort((a, b) => a - b);
const gammaAbc = icKeys.map((index) => {
  const entry = icMap.get(index);
  if (!entry || entry.x === null || entry.y === null) {
    throw new Error(`Missing IC${index}x/IC${index}y`);
  }
  return `${toHex32(entry.x)}${toHex32(entry.y)}`;
});

const out = {
  alpha_g1: `${toHex32(alphaX)}${toHex32(alphaY)}`,
  beta_g2: `${toHex32(betaX1)}${toHex32(betaX2)}${toHex32(betaY1)}${toHex32(betaY2)}`,
  gamma_g2: `${toHex32(gammaX1)}${toHex32(gammaX2)}${toHex32(gammaY1)}${toHex32(gammaY2)}`,
  delta_g2: `${toHex32(deltaX1)}${toHex32(deltaX2)}${toHex32(deltaY1)}${toHex32(deltaY2)}`,
  gamma_abc: gammaAbc,
};

fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outputPath}`);
