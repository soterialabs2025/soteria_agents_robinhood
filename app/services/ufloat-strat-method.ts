/**
 * UFloat stratMethod gates — enum ordinals live in {@link ../abi/contract-enums.ts}.
 */
export {
  UFLOAT_STRAT_METHOD,
  UFLOAT_STRAT_METHOD_LABEL,
  formatUFloatStratMethod,
  type UFloatStratMethodValue,
} from "../abi/contract-enums";

import { UFLOAT_STRAT_METHOD } from "../abi/contract-enums";

/** Agent loops with offensive ranking (momentum + V4 universe): OffensiveOnly | OffensiveDefensive. */
export function ufloatStratMethodAllowsOffensiveMetricsLoop(method: number): boolean {
  return (
    method === UFLOAT_STRAT_METHOD.OffensiveOnly ||
    method === UFLOAT_STRAT_METHOD.OffensiveDefensive
  );
}

/** Agent loops with default ranking metrics: DefensiveOnly | OffensiveDefensive. */
export function ufloatStratMethodAllowsDefaultMetricsLoop(method: number): boolean {
  return (
    method === UFLOAT_STRAT_METHOD.DefensiveOnly ||
    method === UFLOAT_STRAT_METHOD.OffensiveDefensive
  );
}

/** @deprecated Use {@link ufloatStratMethodAllowsOffensiveMetricsLoop}. */
export const ufloatStratMethodAllowsOffensive = ufloatStratMethodAllowsOffensiveMetricsLoop;

/** DEFENSIVE pass after upkeep (mode=DEFENSIVE): DefensiveOnly | OffensiveDefensive. */
export function ufloatStratMethodAllowsDefensive(method: number): boolean {
  return ufloatStratMethodAllowsDefaultMetricsLoop(method);
}

/** ReBalanceOnly: keeper upkeep/harvest only — no agent changeAsset loops. */
export function ufloatStratMethodIsReBalanceOnly(method: number): boolean {
  return method === UFLOAT_STRAT_METHOD.ReBalanceOnly;
}
