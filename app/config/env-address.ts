/**
 * Shared `0x` address reads from process.env (after dotenv).
 */
import type { Address } from "viem";

export function envAddress(name: string): Address | null {
  const raw = process.env[name]?.trim();
  if (raw && /^0x[a-fA-F0-9]{40}$/.test(raw)) return raw as Address;
  return null;
}

export function pickAddr(envName: string, fallback: Address): Address {
  return envAddress(envName) ?? fallback;
}

export function pickAddrAny(envNames: readonly string[], fallback: Address): Address {
  for (const name of envNames) {
    const v = envAddress(name);
    if (v) return v;
  }
  return fallback;
}

/** Required `0x` address. Throws if unset or malformed — no hardcoded fallback. */
export function requireAddr(envName: string): Address {
  const v = envAddress(envName);
  if (!v) {
    throw new Error(`${envName} must be a 20-byte 0x address in the environment`);
  }
  return v;
}

export function requireAddrAny(envNames: readonly string[]): Address {
  for (const name of envNames) {
    const v = envAddress(name);
    if (v) return v;
  }
  throw new Error(
    `${envNames.join(" or ")} must be a 20-byte 0x address in the environment`
  );
}
