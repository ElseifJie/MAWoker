import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

function derive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const ALGORITHM = "scrypt";
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// scrypt needs roughly 128 * cost * blockSize bytes; the node default of 32 MiB
// is below what these parameters require.
const MAX_MEMORY = 64 * 1024 * 1024;

function encode(value: Buffer): string {
  return value.toString("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY,
  });
  return [
    ALGORITHM,
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    encode(salt),
    encode(derived),
  ].join("$");
}

interface ParsedHash {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  digest: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return null;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (
    !Number.isSafeInteger(cost) ||
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(parallelization) ||
    cost <= 0 ||
    blockSize <= 0 ||
    parallelization <= 0
  ) {
    return null;
  }
  let salt: Buffer;
  let digest: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? "", "base64url");
    digest = Buffer.from(parts[5] ?? "", "base64url");
  } catch {
    return null;
  }
  if (salt.length === 0 || digest.length === 0) return null;
  return { cost, blockSize, parallelization, salt, digest };
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const derived = await derive(password, parsed.salt, parsed.digest.length, {
    N: parsed.cost,
    r: parsed.blockSize,
    p: parsed.parallelization,
    maxmem: MAX_MEMORY,
  });
  return derived.length === parsed.digest.length
    ? timingSafeEqual(derived, parsed.digest)
    : false;
}
