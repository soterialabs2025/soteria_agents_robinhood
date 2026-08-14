import { customActionProvider, type WalletProvider } from "@coinbase/agentkit";
import { z } from "zod";

import {
  getTritonMergedConfig,
  getTritonOffensiveEntryEnabled,
  getTritonPriceCheckIntervalMs,
} from "../config/triton-config";
import { loadTritonOverrides, saveTritonOverrides } from "../config/triton-overrides";
import {
  getTritonDefensiveExitStatus,
  setTritonTieredDefensiveExitsEnabled,
} from "../config/triton-defensive-exit-control";
import {
  clearTritonPositionRules,
  loadTritonPositionRules,
  setTritonPositionRulesFromChat,
} from "../config/triton-position-rules";
import {
  clearTritonScheduledAction,
  formatTritonScheduledActionSummary,
  loadTritonScheduledAction,
  scheduleTritonExitToWeth,
  scheduleTritonRotateToToken,
} from "../config/triton-scheduled-actions";

type TritonConfigProviderOptions = {
  /** Chat console: loop toggles only (position/schedule tools are liquidStratMinV4_*). */
  chatProfile?: boolean;
};

/**
 * Triton Config Action Provider
 * Allows toggling Triton loop + offensive auto-entry from the agent console.
 */
export function tritonConfigActionProvider(options?: TritonConfigProviderOptions) {
  const loopTools = [
    {
      name: "triton_getConfig",
      description:
        "Get Triton loop settings (LiquidStratMinV4 default off, UFloatKeeperV4 default on when TRITON_PRIVATE_KEY set).",
      schema: z.object({}),
      invoke: async () => {
        try {
          const overrides = loadTritonOverrides();
          return JSON.stringify({
            success: true,
            config: getTritonMergedConfig(),
            overrides,
            note: "Restart demeter after override changes. Env: TRITON_LIQUID_STRAT_LOOP_ENABLED, TRITON_UFLOAT_KEEPER_ENABLED.",
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_setEnabled",
      description:
        "Disable LiquidStratMinV4 loop (legacy tritonEnabled in overrides). Does not affect UFloatKeeperV4. Restart demeter.",
      schema: z.object({
        enabled: z.boolean().describe("false = block LiquidStratMinV4"),
      }),
      invoke: async (_walletProvider: WalletProvider, args: { enabled: boolean }) => {
        try {
          saveTritonOverrides({ tritonEnabled: args.enabled });
          return JSON.stringify({
            success: true,
            message: `Saved: tritonEnabled=${args.enabled}. Restart demeter to apply.`,
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_setOffensiveEntryEnabled",
      description:
        "Enable/disable LiquidStratMinV4 offensive auto-entry (WETH → token). Only applies when LiquidStratMinV4 loop is enabled. Requires Demeter restart.",
      schema: z.object({
        enabled: z.boolean().describe("true = allow offensive auto-entry, false = disable it"),
      }),
      invoke: async (_walletProvider: WalletProvider, args: { enabled: boolean }) => {
        try {
          saveTritonOverrides({ tritonOffensiveEntryEnabled: args.enabled });
          return JSON.stringify({
            success: true,
            message: `Saved: tritonOffensiveEntryEnabled=${args.enabled}. Restart demeter to apply.`,
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_setPriceCheckIntervalMs",
      description:
        "Set Triton price check loop interval in milliseconds (min 5000). Requires Demeter restart to take effect.",
      schema: z.object({
        ms: z.number().int().min(5000).describe("Interval in milliseconds (e.g. 60000 for 60s)"),
      }),
      invoke: async (_walletProvider: WalletProvider, args: { ms: number }) => {
        try {
          saveTritonOverrides({ tritonPriceCheckIntervalMs: args.ms });
          return JSON.stringify({
            success: true,
            message: `Saved: tritonPriceCheckIntervalMs=${args.ms}. Restart demeter to apply.`,
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_setUfloatRankingGates",
      description:
        "Toggle UFloat offensive-metrics min weighted score gate. applyMinWeightedScore: when true, offensive-metrics requires top pick score ≥ scheduledChangeMinWeightedScore. Restart demeter.",
      schema: z.object({
        applyMinWeightedScore: z
          .boolean()
          .describe("false = allow offensive-metrics pick on any top ranked score"),
      }),
      invoke: async (
        _walletProvider: WalletProvider,
        args: { applyMinWeightedScore: boolean }
      ) => {
        try {
          saveTritonOverrides({ ufloatApplyScheduledChangeMinWeightedScore: args.applyMinWeightedScore });
          return JSON.stringify({
            success: true,
            message: `Saved UFloat ranking gate: ufloatApplyScheduledChangeMinWeightedScore=${args.applyMinWeightedScore}. Restart demeter to apply.`,
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
  ];

  const tradingTools = [
    {
      name: "triton_getDefensiveExitRules",
      description:
        "Show tiered defensive exit ON/OFF, tier thresholds, and saved custom take-profit/stop-loss rules for Triton.",
      schema: z.object({}),
      invoke: async () => {
        try {
          const status = getTritonDefensiveExitStatus();
          const custom = loadTritonPositionRules();
          return JSON.stringify({
            success: true,
            tieredExitsEnabled: status.tieredExitsEnabled,
            tieredRulesSummary: status.tieredRulesSummary,
            tieredRules: status.tieredRules,
            customPositionRules: custom,
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_setTieredDefensiveExits",
      description:
        "Enable/disable tiered HIGH/MEDIUM/LOW defensive exits. When false, only triton_setPositionRules custom TP/SL apply.",
      schema: z.object({
        enabled: z.boolean(),
        notes: z.string().optional(),
      }),
      invoke: async (_wp: WalletProvider, args: { enabled: boolean; notes?: string }) => {
        try {
          const control = setTritonTieredDefensiveExitsEnabled(args.enabled, args.notes);
          return JSON.stringify({
            success: true,
            message: args.enabled
              ? "Tiered defensive exits enabled."
              : "Tiered exits OFF — set custom rules with triton_setPositionRules.",
            data: control,
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_getPositionRules",
      description: "Show custom take-profit / stop-loss rules saved for a Triton-held token.",
      schema: z.object({}),
      invoke: async () => {
        try {
          return JSON.stringify({ success: true, data: loadTritonPositionRules() });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_setPositionRules",
      description:
        "Set custom exit rules for whatever token Triton holds (TP/SL apply to any held asset after rotation). " +
        "takeProfitPctFromEntry: exit at +N% gain; stopLossPctFromEntry: exit at −N% loss. Next price tick.",
      schema: z.object({
        token: z.string().optional().describe("Optional — ignored"),
        takeProfitPctFromEntry: z.number().optional(),
        stopLossPctFromEntry: z.number().optional(),
        peakTrailDrawdownPct: z.number().optional(),
        clear: z.boolean().optional(),
      }),
      invoke: async (
        _wp: WalletProvider,
        args: {
          token?: string;
          takeProfitPctFromEntry?: number;
          stopLossPctFromEntry?: number;
          peakTrailDrawdownPct?: number;
          clear?: boolean;
        }
      ) => {
        try {
          if (args.clear) {
            clearTritonPositionRules();
            return JSON.stringify({ success: true, cleared: true });
          }
          const rules = setTritonPositionRulesFromChat({
            token: args.token,
            takeProfitPctFromEntry: args.takeProfitPctFromEntry,
            stopLossPctFromEntry: args.stopLossPctFromEntry,
            peakTrailDrawdownPct: args.peakTrailDrawdownPct,
          });
          return JSON.stringify({ success: true, data: rules, savedPath: rules.savedPath });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_getScheduledAction",
      description: "Show pending time-based Triton trade (scheduled exit or rotate).",
      schema: z.object({}),
      invoke: async () => {
        try {
          const action = loadTritonScheduledAction();
          return JSON.stringify({
            success: true,
            data: action,
            summary: action ? formatTritonScheduledActionSummary(action) : null,
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_scheduleExit",
      description:
        "Schedule selling the held token to WETH after a delay (e.g. delayMinutes: 60). Takes effect on next price tick after time elapses.",
      schema: z.object({
        delayMinutes: z.number().optional(),
        delayHours: z.number().optional(),
        notes: z.string().optional(),
      }),
      invoke: async (
        _wp: WalletProvider,
        args: { delayMinutes?: number; delayHours?: number; notes?: string }
      ) => {
        try {
          const action = scheduleTritonExitToWeth(args, args.notes);
          return JSON.stringify({
            success: true,
            data: action,
            summary: formatTritonScheduledActionSummary(action),
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_scheduleRotate",
      description:
        "Schedule rotating to a token after a delay (e.g. token nook, delayMinutes: 10). Works from WETH or another held token.",
      schema: z.object({
        token: z.string(),
        delayMinutes: z.number().optional(),
        delayHours: z.number().optional(),
        notes: z.string().optional(),
      }),
      invoke: async (
        _wp: WalletProvider,
        args: {
          token: string;
          delayMinutes?: number;
          delayHours?: number;
          notes?: string;
        }
      ) => {
        try {
          const action = scheduleTritonRotateToToken(
            args.token,
            { delayMinutes: args.delayMinutes, delayHours: args.delayHours },
            args.notes
          );
          return JSON.stringify({
            success: true,
            data: action,
            summary: formatTritonScheduledActionSummary(action),
          });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      name: "triton_clearScheduledAction",
      description: "Cancel the pending time-based exit or rotate.",
      schema: z.object({}),
      invoke: async () => {
        try {
          clearTritonScheduledAction();
          return JSON.stringify({ success: true, cleared: true });
        } catch (e) {
          return JSON.stringify({
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
  ];

  return customActionProvider(options?.chatProfile ? loopTools : [...loopTools, ...tradingTools]);
}
