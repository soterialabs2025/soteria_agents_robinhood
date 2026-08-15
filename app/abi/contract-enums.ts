/**
 * On-chain enum ordinals — update here when Solidity enums change, alongside app/abi/*.json refreshes.
 *
 * Standard JSON ABIs often emit mode() as plain uint8; enum member names live in Solidity source.
 */

/** UFloatStrategy.mode — `enum Mode { NORMAL, DEFENSIVE, OFFENSIVE, STABLE }` (no NEUTRAL). */
export const UFLOAT_STRATEGY_MODE = {
  Normal: 0,
  Defensive: 1,
  Offensive: 2,
  Stable: 3,
} as const;

export type UFloatStrategyModeValue =
  (typeof UFLOAT_STRATEGY_MODE)[keyof typeof UFLOAT_STRATEGY_MODE];

export const UFLOAT_STRATEGY_MODE_LABEL: Record<UFloatStrategyModeValue, string> = {
  [UFLOAT_STRATEGY_MODE.Normal]: "NORMAL",
  [UFLOAT_STRATEGY_MODE.Defensive]: "DEFENSIVE",
  [UFLOAT_STRATEGY_MODE.Offensive]: "OFFENSIVE",
  [UFLOAT_STRATEGY_MODE.Stable]: "STABLE",
};

/** UStrategyManager.stratMethod — `enum StratMethod { ReBalanceOnly, OffensiveOnly, DefensiveOnly, OffensiveDefensive }`. */
export const UFLOAT_STRAT_METHOD = {
  ReBalanceOnly: 0,
  OffensiveOnly: 1,
  DefensiveOnly: 2,
  OffensiveDefensive: 3,
} as const;

export type UFloatStratMethodValue =
  (typeof UFLOAT_STRAT_METHOD)[keyof typeof UFLOAT_STRAT_METHOD];

export const UFLOAT_STRAT_METHOD_LABEL: Record<UFloatStratMethodValue, string> = {
  [UFLOAT_STRAT_METHOD.ReBalanceOnly]: "ReBalanceOnly",
  [UFLOAT_STRAT_METHOD.OffensiveOnly]: "OffensiveOnly",
  [UFLOAT_STRAT_METHOD.DefensiveOnly]: "DefensiveOnly",
  [UFLOAT_STRAT_METHOD.OffensiveDefensive]: "OffensiveDefensive",
};

/** FloatStrategy / FloatStrategyV4.mode — `enum Mode { NORMAL, DEFENSIVE, OFFENSIVE, NEUTRAL, STABLE }`. */
export const FLOAT_STRATEGY_MODE = {
  Normal: 0,
  Defensive: 1,
  Offensive: 2,
  Neutral: 3,
  Stable: 4,
} as const;

export type FloatStrategyModeValue =
  (typeof FLOAT_STRATEGY_MODE)[keyof typeof FLOAT_STRATEGY_MODE];

export const FLOAT_STRATEGY_MODE_LABEL: Record<FloatStrategyModeValue, string> = {
  [FLOAT_STRATEGY_MODE.Normal]: "NORMAL",
  [FLOAT_STRATEGY_MODE.Defensive]: "DEFENSIVE",
  [FLOAT_STRATEGY_MODE.Offensive]: "OFFENSIVE",
  [FLOAT_STRATEGY_MODE.Neutral]: "NEUTRAL",
  [FLOAT_STRATEGY_MODE.Stable]: "STABLE",
};

export function formatUFloatStrategyMode(mode: number): string {
  return UFLOAT_STRATEGY_MODE_LABEL[mode as UFloatStrategyModeValue] ?? `Unknown(${mode})`;
}

export function formatUFloatStratMethod(method: number): string {
  return UFLOAT_STRAT_METHOD_LABEL[method as UFloatStratMethodValue] ?? `Unknown(${method})`;
}

/** AutoStrategyV3Rh.mode — same ordinals as UFloat: `enum Mode { NORMAL, DEFENSIVE, OFFENSIVE, STABLE }` (no NEUTRAL). */
export const AUTO_STRATEGY_MODE = UFLOAT_STRATEGY_MODE;

export type AutoStrategyModeValue = UFloatStrategyModeValue;

export const AUTO_STRATEGY_MODE_LABEL = UFLOAT_STRATEGY_MODE_LABEL;

export function formatAutoStrategyMode(mode: number): string {
  return formatUFloatStrategyMode(mode);
}

export function formatFloatStrategyMode(mode: number): string {
  return FLOAT_STRATEGY_MODE_LABEL[mode as FloatStrategyModeValue] ?? `Unknown(${mode})`;
}
