/**
 * Standalone Triton entry — same loop as Demeter's {@link tritonLiquidLoop}.
 * Prefer: `npm run demeter` (starts Float + Liquid loops when TRITON_PRIVATE_KEY is set).
 */
import {
  areDemeterLoopsEnabled,
  demeterLoopsDisabledMessage,
  loadDemeterEnv,
} from "../config/demeter-loops";
import { isLiquidStratMinV4LoopEnabled } from "../config/triton-config";
import { tritonLiquidLoop } from "./triton-liquid-loop";

loadDemeterEnv();

if (!areDemeterLoopsEnabled()) {
  console.log("[Triton]", demeterLoopsDisabledMessage());
  process.exit(0);
}

if (!isLiquidStratMinV4LoopEnabled()) {
  console.log(
    "[Triton] LiquidStratMinV4 loop is disabled (default). Set TRITON_LIQUID_STRAT_LOOP_ENABLED=true or triton.overrides.json liquidStratMinV4LoopEnabled. Use Demeter for UFloatKeeperV4."
  );
  process.exit(0);
}

tritonLiquidLoop().catch((e) => {
  console.error(e);
  process.exit(1);
});
