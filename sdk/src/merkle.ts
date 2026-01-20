import { poseidonHash } from "./poseidon";

export const MERKLE_DEPTH = 20;

export type MerklePath = {
  root: bigint;
  pathElements: bigint[];
  pathIndices: number[];
};

const hashPair = async (left: bigint, right: bigint) => poseidonHash([left, right]);

export async function buildZeroes(depth = MERKLE_DEPTH): Promise<bigint[]> {
  const zeroes: bigint[] = [0n];
  for (let i = 1; i <= depth; i += 1) {
    zeroes.push(await hashPair(zeroes[i - 1], zeroes[i - 1]));
  }
  return zeroes;
}

export async function buildMerkleTree(leaves: bigint[], depth = MERKLE_DEPTH) {
  const zeroes = await buildZeroes(depth);
  const levels: bigint[][] = [leaves.slice()];
  for (let level = 0; level < depth; level += 1) {
    const current = levels[level];
    const next: bigint[] = [];
    const width = Math.max(current.length, 1);
    for (let i = 0; i < width; i += 2) {
      const left = current[i] ?? zeroes[level];
      const right = current[i + 1] ?? zeroes[level];
      next.push(await hashPair(left, right));
    }
    levels.push(next);
  }
  const root = levels[depth][0] ?? zeroes[depth];
  return { root, levels, zeroes };
}

export async function getMerklePath(
  leaves: bigint[],
  leafIndex: number,
  depth = MERKLE_DEPTH
): Promise<MerklePath> {
  const { root, levels, zeroes } = await buildMerkleTree(leaves, depth);
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let index = leafIndex;
  for (let level = 0; level < depth; level += 1) {
    const current = levels[level];
    const siblingIndex = index ^ 1;
    const sibling = current[siblingIndex] ?? zeroes[level];
    pathElements.push(sibling);
    pathIndices.push(index & 1);
    index = Math.floor(index / 2);
  }
  return { root, pathElements, pathIndices };
}
