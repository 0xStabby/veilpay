import { buildPoseidon } from "circomlibjs";

let poseidonPromise: Promise<ReturnType<typeof buildPoseidon>> | null = null;

async function getPoseidon() {
  if (!poseidonPromise) {
    poseidonPromise = buildPoseidon();
  }
  return poseidonPromise;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const hash = poseidon(inputs.map((value) => BigInt(value)));
  return BigInt(poseidon.F.toString(hash));
}
