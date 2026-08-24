/**
 * Robinhood keeper pipelines — Auto Uni V3 / Uni V4 / Sushi V3 + UFloat V3 / V4.
 * Addresses from docs/ADDRESSES.md. Env overrides per pipeline (see getters).
 *
 * AutoKeeper RhV3 / RhV4 / Sv3 share the same operator surface
 * (performUpkeepBatch, performHarvestBatch(ids, skipIncreaseLiquidity), watched).
 */
import type { Abi, Address } from "viem";

import autoKeeperRhV3Abi from "../abi/auto-vaults-rh-v3/AutoKeeperRhV3.abi.json";
import autoKeeperRhV4Abi from "../abi/auto-vaults-rh-v4/AutoKeeperRhV4.abi.json";
import autoKeeperSv3Abi from "../abi/auto-vault-sushi/AutoKeeperSv3.abi.json";
import ufloatKeeperV3Abi from "../abi/ustrategy-rh-v3/UFloatKeeperV3.abi.json";
import ufloatKeeperV4Abi from "../abi/ustrategy-rh-v4/UFloatKeeper.abi.json";

import { pickAddr } from "./env-address";
import { getOperatorRegistryAddress } from "./operator-registry-config";

export type AutoKeeperPipelineId = "auto-rh-v3" | "auto-rh-v4" | "auto-sv3";
export type UfloatKeeperPipelineId = "ufloat-rh-v3" | "ufloat-rh-v4";
export type RhKeeperPipelineId = AutoKeeperPipelineId | UfloatKeeperPipelineId;

export type AutoKeeperPipeline = {
  id: AutoKeeperPipelineId;
  label: string;
  kind: "auto";
  keeperAddress: Address;
  factoryAddress: Address;
  swapRouterAddress: Address;
  operatorRegistryAddress: Address;
  abi: Abi;
};

export type UfloatKeeperPipeline = {
  id: UfloatKeeperPipelineId;
  label: string;
  kind: "ufloat";
  keeperAddress: Address;
  factoryAddress: Address;
  swapRouterAddress: Address;
  operatorRegistryAddress: Address;
  abi: Abi;
};

function envFlagFalse(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "false" || raw === "0" || raw === "no";
}

/** RH (4663) — AutoVault Uni V3 */
export const AUTO_KEEPER_RH_V3_ADDRESS = "0xD35CE6610AcB37D545bb5ec4192fC50505Dd26Ad" as const;
export const AUTO_FACTORY_RH_V3_ADDRESS = "0xB3E65742e90af23f30527A9745B63F90DAA48B78" as const;
export const AUTO_SWAP_ROUTER_RH_V3_ADDRESS = "0x8A8c18445792e04e8512D5c6CD680331F9575a3F" as const;

/** RH (4663) — AutoVault Uni V4 */
export const AUTO_KEEPER_RH_V4_ADDRESS = "0x79F9ea39E7e5304791DF8cfEe835F6592c35e022" as const;
export const AUTO_FACTORY_RH_V4_ADDRESS = "0x3D19ecDb90B06626f8EC860F7aec9A378E760E8D" as const;
export const AUTO_SWAP_ROUTER_RH_V4_ADDRESS = "0x724265D83E2Ea8296Bd61177d7B86a92Ba7e2520" as const;

/** RH (4663) — AutoVault Sushi V3 */
export const AUTO_KEEPER_SV3_ADDRESS = "0x3Cb0A8c25356BF5764C4510A79458e73a6639372" as const;
export const AUTO_FACTORY_SV3_ADDRESS = "0x0bb7e7A4a57ad938a253d2302604D1256067785A" as const;
export const AUTO_SWAP_ROUTER_SV3_ADDRESS = "0x568dCA271e5F7edb9769f5eA6076e2DA8D4014e8" as const;

/** RH (4663) — UFloat V3 */
export const UFLOAT_KEEPER_RH_V3_ADDRESS = "0xe2E744063446E372B9E28e4BB38aaBFcc6D43eE8" as const;
export const UFLOAT_FACTORY_RH_V3_ADDRESS = "0xA8966d59f38e7bE263C533Ccda87F36eaf5FFefE" as const;
export const UFLOAT_SWAP_ROUTER_RH_V3_ADDRESS = "0x932f208D180dB8e375E17f88e86A9C1a81d7ACa8" as const;

/** RH (4663) — UFloat V4 */
export const UFLOAT_KEEPER_RH_V4_ADDRESS = "0x2cF7c9aB33a8248B07435d58cc7754eB1EaB8d12" as const;
export const UFLOAT_FACTORY_RH_V4_ADDRESS = "0xBDE2231aC15DdbACa7A24837875e6F7DF0a855D9" as const;
export const UFLOAT_SWAP_ROUTER_RH_V4_ADDRESS = "0x562cfd3C373A649932597AD5D7a7c1CEa8402A76" as const;

export function getAutoRhV3Pipeline(): AutoKeeperPipeline {
  return {
    id: "auto-rh-v3",
    label: "AutoKeeperRhV3",
    kind: "auto",
    keeperAddress: pickAddr("AUTO_KEEPER_RH_V3_ADDRESS", AUTO_KEEPER_RH_V3_ADDRESS),
    factoryAddress: pickAddr("AUTO_FACTORY_RH_V3_ADDRESS", AUTO_FACTORY_RH_V3_ADDRESS),
    swapRouterAddress: pickAddr("AUTO_SWAP_ROUTER_RH_V3_ADDRESS", AUTO_SWAP_ROUTER_RH_V3_ADDRESS),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: autoKeeperRhV3Abi as Abi,
  };
}

export function getAutoRhV4Pipeline(): AutoKeeperPipeline {
  return {
    id: "auto-rh-v4",
    label: "AutoKeeperRhV4",
    kind: "auto",
    keeperAddress: pickAddr("AUTO_KEEPER_RH_V4_ADDRESS", AUTO_KEEPER_RH_V4_ADDRESS),
    factoryAddress: pickAddr("AUTO_FACTORY_RH_V4_ADDRESS", AUTO_FACTORY_RH_V4_ADDRESS),
    swapRouterAddress: pickAddr("AUTO_SWAP_ROUTER_RH_V4_ADDRESS", AUTO_SWAP_ROUTER_RH_V4_ADDRESS),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: autoKeeperRhV4Abi as Abi,
  };
}

export function getAutoSv3Pipeline(): AutoKeeperPipeline {
  return {
    id: "auto-sv3",
    label: "AutoKeeperSv3",
    kind: "auto",
    keeperAddress: pickAddr("AUTO_KEEPER_SV3_ADDRESS", AUTO_KEEPER_SV3_ADDRESS),
    factoryAddress: pickAddr("AUTO_FACTORY_SV3_ADDRESS", AUTO_FACTORY_SV3_ADDRESS),
    swapRouterAddress: pickAddr("AUTO_SWAP_ROUTER_SV3_ADDRESS", AUTO_SWAP_ROUTER_SV3_ADDRESS),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: autoKeeperSv3Abi as Abi,
  };
}

export function getUfloatRhV3Pipeline(): UfloatKeeperPipeline {
  return {
    id: "ufloat-rh-v3",
    label: "UFloatKeeperV3",
    kind: "ufloat",
    keeperAddress: pickAddr("UFLOAT_KEEPER_RH_V3_ADDRESS", UFLOAT_KEEPER_RH_V3_ADDRESS),
    factoryAddress: pickAddr("UFLOAT_FACTORY_RH_V3_ADDRESS", UFLOAT_FACTORY_RH_V3_ADDRESS),
    swapRouterAddress: pickAddr("UFLOAT_SWAP_ROUTER_RH_V3_ADDRESS", UFLOAT_SWAP_ROUTER_RH_V3_ADDRESS),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: ufloatKeeperV3Abi as Abi,
  };
}

export function getUfloatRhV4Pipeline(): UfloatKeeperPipeline {
  return {
    id: "ufloat-rh-v4",
    label: "UFloatKeeperV4",
    kind: "ufloat",
    keeperAddress: pickAddr("UFLOAT_KEEPER_RH_V4_ADDRESS", UFLOAT_KEEPER_RH_V4_ADDRESS),
    factoryAddress: pickAddr("UFLOAT_FACTORY_RH_V4_ADDRESS", UFLOAT_FACTORY_RH_V4_ADDRESS),
    swapRouterAddress: pickAddr("UFLOAT_SWAP_ROUTER_RH_V4_ADDRESS", UFLOAT_SWAP_ROUTER_RH_V4_ADDRESS),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: ufloatKeeperV4Abi as Abi,
  };
}

/**
 * Auto pipelines to run. Default: all three.
 * Disable one: `AUTO_KEEPER_RH_V3_ENABLED=false` (same for RH_V4 / SV3).
 * Or restrict: `AUTO_KEEPER_PIPELINES=auto-rh-v3,auto-rh-v4,auto-sv3`
 */
export function getEnabledAutoKeeperPipelines(): AutoKeeperPipeline[] {
  const allow = parsePipelineAllowlist("AUTO_KEEPER_PIPELINES");
  const all: AutoKeeperPipeline[] = [
    getAutoRhV3Pipeline(),
    getAutoRhV4Pipeline(),
    getAutoSv3Pipeline(),
  ];
  return all.filter((p) => {
    if (allow && !allow.has(p.id)) return false;
    if (p.id === "auto-rh-v3" && envFlagFalse("AUTO_KEEPER_RH_V3_ENABLED")) return false;
    if (p.id === "auto-rh-v4" && envFlagFalse("AUTO_KEEPER_RH_V4_ENABLED")) return false;
    if (p.id === "auto-sv3" && envFlagFalse("AUTO_KEEPER_SV3_ENABLED")) return false;
    return true;
  });
}

/**
 * UFloat RH pipelines. Default: V3 + V4.
 * Disable: `UFLOAT_KEEPER_RH_V3_ENABLED=false` / `UFLOAT_KEEPER_RH_V4_ENABLED=false`.
 */
export function getEnabledUfloatKeeperPipelines(): UfloatKeeperPipeline[] {
  const allow = parsePipelineAllowlist("UFLOAT_KEEPER_PIPELINES");
  const all: UfloatKeeperPipeline[] = [getUfloatRhV3Pipeline(), getUfloatRhV4Pipeline()];
  return all.filter((p) => {
    if (allow && !allow.has(p.id)) return false;
    if (p.id === "ufloat-rh-v3" && envFlagFalse("UFLOAT_KEEPER_RH_V3_ENABLED")) return false;
    if (p.id === "ufloat-rh-v4" && envFlagFalse("UFLOAT_KEEPER_RH_V4_ENABLED")) return false;
    return true;
  });
}

function parsePipelineAllowlist(envName: string): Set<string> | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}
