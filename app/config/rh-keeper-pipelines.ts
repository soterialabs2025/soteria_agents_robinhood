/**
 * Robinhood keeper pipelines — Auto Uni V3 / Uni V4 / Sushi V3 + UFloat V3 / V4.
 * Addresses come from env only. Missing vars throw; there are no code fallbacks.
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

import { requireAddr } from "./env-address";
import { getOperatorRegistryAddress } from "./operator-registry-config";

export type AutoKeeperPipelineId = "auto-rh-v3" | "auto-rh-v4" | "auto-sv3";
export type UfloatKeeperPipelineId = "ufloat-rh-v3" | "ufloat-rh-v4";
export type RhKeeperPipelineId = AutoKeeperPipelineId | UfloatKeeperPipelineId;

export type AutoAmmKind = "v3" | "v4";

export type AutoKeeperPipeline = {
  id: AutoKeeperPipelineId;
  label: string;
  kind: "auto";
  amm: AutoAmmKind;
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

export function getAutoRhV3Pipeline(): AutoKeeperPipeline {
  return {
    id: "auto-rh-v3",
    label: "AutoKeeperRhV3",
    kind: "auto",
    amm: "v3",
    keeperAddress: requireAddr("AUTO_KEEPER_RH_V3_ADDRESS"),
    factoryAddress: requireAddr("AUTO_FACTORY_RH_V3_ADDRESS"),
    swapRouterAddress: requireAddr("AUTO_SWAP_ROUTER_RH_V3_ADDRESS"),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: autoKeeperRhV3Abi as Abi,
  };
}

export function getAutoRhV4Pipeline(): AutoKeeperPipeline {
  return {
    id: "auto-rh-v4",
    label: "AutoKeeperRhV4",
    kind: "auto",
    amm: "v4",
    keeperAddress: requireAddr("AUTO_KEEPER_RH_V4_ADDRESS"),
    factoryAddress: requireAddr("AUTO_FACTORY_RH_V4_ADDRESS"),
    swapRouterAddress: requireAddr("AUTO_SWAP_ROUTER_RH_V4_ADDRESS"),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: autoKeeperRhV4Abi as Abi,
  };
}

export function getAutoSv3Pipeline(): AutoKeeperPipeline {
  return {
    id: "auto-sv3",
    label: "AutoKeeperSv3",
    kind: "auto",
    amm: "v3",
    keeperAddress: requireAddr("AUTO_KEEPER_SV3_ADDRESS"),
    factoryAddress: requireAddr("AUTO_FACTORY_SV3_ADDRESS"),
    swapRouterAddress: requireAddr("AUTO_SWAP_ROUTER_SV3_ADDRESS"),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: autoKeeperSv3Abi as Abi,
  };
}

export function getUfloatRhV3Pipeline(): UfloatKeeperPipeline {
  return {
    id: "ufloat-rh-v3",
    label: "UFloatKeeperV3",
    kind: "ufloat",
    keeperAddress: requireAddr("UFLOAT_KEEPER_RH_V3_ADDRESS"),
    factoryAddress: requireAddr("UFLOAT_FACTORY_RH_V3_ADDRESS"),
    swapRouterAddress: requireAddr("UFLOAT_SWAP_ROUTER_RH_V3_ADDRESS"),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: ufloatKeeperV3Abi as Abi,
  };
}

export function getUfloatRhV4Pipeline(): UfloatKeeperPipeline {
  return {
    id: "ufloat-rh-v4",
    label: "UFloatKeeperV4",
    kind: "ufloat",
    keeperAddress: requireAddr("UFLOAT_KEEPER_RH_V4_ADDRESS"),
    factoryAddress: requireAddr("UFLOAT_FACTORY_RH_V4_ADDRESS"),
    swapRouterAddress: requireAddr("UFLOAT_SWAP_ROUTER_RH_V4_ADDRESS"),
    operatorRegistryAddress: getOperatorRegistryAddress(),
    abi: ufloatKeeperV4Abi as Abi,
  };
}

/**
 * Auto pipelines to run. Default: all three.
 * Disable one: `AUTO_KEEPER_RH_V3_ENABLED=false` (same for RH_V4 / SV3).
 * Or restrict: `AUTO_KEEPER_PIPELINES=auto-rh-v3,auto-rh-v4,auto-sv3`
 * Addresses are required only for enabled pipelines.
 */
export function getEnabledAutoKeeperPipelines(): AutoKeeperPipeline[] {
  const allow = parsePipelineAllowlist("AUTO_KEEPER_PIPELINES");
  const candidates: { id: AutoKeeperPipelineId; enabled: boolean; build: () => AutoKeeperPipeline }[] =
    [
      {
        id: "auto-rh-v3",
        enabled: !envFlagFalse("AUTO_KEEPER_RH_V3_ENABLED"),
        build: getAutoRhV3Pipeline,
      },
      {
        id: "auto-rh-v4",
        enabled: !envFlagFalse("AUTO_KEEPER_RH_V4_ENABLED"),
        build: getAutoRhV4Pipeline,
      },
      {
        id: "auto-sv3",
        enabled: !envFlagFalse("AUTO_KEEPER_SV3_ENABLED"),
        build: getAutoSv3Pipeline,
      },
    ];
  return candidates
    .filter((p) => (!allow || allow.has(p.id)) && p.enabled)
    .map((p) => p.build());
}

/**
 * UFloat RH pipelines. Default: V3 + V4.
 * Disable: `UFLOAT_KEEPER_RH_V3_ENABLED=false` / `UFLOAT_KEEPER_RH_V4_ENABLED=false`.
 * Addresses are required only for enabled pipelines.
 */
export function getEnabledUfloatKeeperPipelines(): UfloatKeeperPipeline[] {
  const allow = parsePipelineAllowlist("UFLOAT_KEEPER_PIPELINES");
  const candidates: {
    id: UfloatKeeperPipelineId;
    enabled: boolean;
    build: () => UfloatKeeperPipeline;
  }[] = [
    {
      id: "ufloat-rh-v3",
      enabled: !envFlagFalse("UFLOAT_KEEPER_RH_V3_ENABLED"),
      build: getUfloatRhV3Pipeline,
    },
    {
      id: "ufloat-rh-v4",
      enabled: !envFlagFalse("UFLOAT_KEEPER_RH_V4_ENABLED"),
      build: getUfloatRhV4Pipeline,
    },
  ];
  return candidates
    .filter((p) => (!allow || allow.has(p.id)) && p.enabled)
    .map((p) => p.build());
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
