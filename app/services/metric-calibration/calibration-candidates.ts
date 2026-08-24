import { getStableUsdcWethPair, getStableV4WethAddress } from "../../config/demeter-config";

function stableCalibrationAddressesLc(): Set<string> {
  return new Set([
    getStableV4WethAddress().toLowerCase(),
    getStableUsdcWethPair().tokenAddress.toLowerCase(),
  ]);
}

/** WETH / USDC stable rotations are not useful for offensive metric calibration. */
export function isStableCalibrationTokenAddress(address: string | null | undefined): boolean {
  if (!address?.trim()) return false;
  return stableCalibrationAddressesLc().has(address.trim().toLowerCase());
}

/** Need at least two rankable tokens to compare 6h forward returns. */
export function filterCalibrationTopThree<T extends { address: string }>(topThree: T[]): T[] {
  return topThree.filter((t) => !isStableCalibrationTokenAddress(t.address));
}

export function shouldRecordCalibrationEvent(topThree: Array<{ address: string }>): boolean {
  return filterCalibrationTopThree(topThree).length >= 2;
}

export function isStableOnlyCalibrationEvent(
  snapshots: Array<{ address: string }> | undefined
): boolean {
  if (!snapshots?.length) return false;
  return snapshots.every((s) => isStableCalibrationTokenAddress(s.address));
}
