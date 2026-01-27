#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CIRCUIT_DIR="$ROOT_DIR/circuits"
BUILD_DIR="$CIRCUIT_DIR/build"
PUBLIC_DIR="$ROOT_DIR/app/public/prover"
PTAU="$CIRCUIT_DIR/powersOfTau28_hez_final_17.ptau"

mkdir -p "$BUILD_DIR" "$PUBLIC_DIR"

if [ ! -f "$PTAU" ]; then
  echo "Downloading powers of tau..."
  curl -L -o "$PTAU" https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau
fi

pnpm exec circom2 "$CIRCUIT_DIR/veilpay.circom" --r1cs --wasm --sym -l node_modules/circomlib/circuits -o "$BUILD_DIR"

pnpm exec snarkjs groth16 setup "$BUILD_DIR/veilpay.r1cs" "$PTAU" "$BUILD_DIR/veilpay_0000.zkey"

pnpm exec snarkjs zkey contribute "$BUILD_DIR/veilpay_0000.zkey" "$BUILD_DIR/veilpay_final.zkey" \
  --name="veilpay-dev" -v -e="$(openssl rand -hex 16)"

pnpm exec snarkjs zkey export verificationkey "$BUILD_DIR/veilpay_final.zkey" "$BUILD_DIR/verification_key.json"

node "$ROOT_DIR/scripts/export-verifier-key.js" \
  "$BUILD_DIR/verification_key.json" "$BUILD_DIR/verifier_key.json"

cp "$BUILD_DIR/veilpay_js/veilpay.wasm" "$PUBLIC_DIR/veilpay.wasm"
cp "$BUILD_DIR/veilpay_final.zkey" "$PUBLIC_DIR/veilpay.zkey"
cp "$BUILD_DIR/verification_key.json" "$PUBLIC_DIR/verification_key.json"
cp "$BUILD_DIR/verifier_key.json" "$ROOT_DIR/app/src/fixtures/verifier_key.json"

echo "Circuit artifacts written to $PUBLIC_DIR"
