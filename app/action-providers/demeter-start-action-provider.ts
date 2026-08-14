import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { spawn } from "child_process";
import { formatChangeStrategyIntervalForLog, getMergedConfig } from "../config/demeter-config";
import {
  areDemeterLoopsEnabled,
  demeterLoopsDisabledMessage,
} from "../config/demeter-loops";
import { setDemeterStopSignal, checkDemeterStopSignal } from "../config/demeter-stop";

/**
 * Start the continuous Demeter loops (same as npm run demeter).
 * Spawns demeter-agent.ts as a detached background process.
 */
export function demeterStartActionProvider() {
  return customActionProvider([
    {
      name: "demeter_stopLoops",
      description: `Stop the continuous Demeter loops. Sends a stop signal to the Demeter process; it will shut down within a few seconds. Use when the user asks to "stop demeter", "stop the demeter loops", "stop demeter loops", or similar.`,
      schema: z.object({}),
      invoke: async () => {
        try {
          if (checkDemeterStopSignal()) {
            return JSON.stringify({
              success: true,
              message: "Stop signal was already set. Demeter will shut down shortly if it is running.",
              timestamp: new Date().toISOString(),
            });
          }
          setDemeterStopSignal();
          return JSON.stringify({
            success: true,
            message:
              "Stop signal sent. Demeter will shut down within a few seconds. (If Demeter was started via pm2, use 'pm2 stop demeter' instead.)",
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Failed to set Demeter stop signal",
          });
        }
      },
    },
    {
      name: "demeter_startLoops",
      description: `Start the continuous Demeter loops - the same as running "npm run demeter". Starts upkeep, harvest, change strategy, and price check loops (intervals from config). Use when the user asks to "start demeter", "run demeter", or "start the demeter loops".`,
      schema: z.object({}),
      invoke: async () => {
        try {
          if (!areDemeterLoopsEnabled()) {
            return JSON.stringify({
              success: false,
              error: demeterLoopsDisabledMessage(),
            });
          }
          const cwd = process.cwd();
          const isWin = process.platform === "win32";

          const child = spawn(
            isWin ? "npm.cmd" : "npm",
            ["run", "demeter"],
            {
              cwd,
              detached: true,
              stdio: "ignore",
              shell: isWin,
              env: { ...process.env },
            }
          );

          child.unref();

          const cfg = getMergedConfig();
          const pollMin = Math.round(cfg.pollMs / 60000);
          const harvestMin = Math.round(cfg.harvestIntervalMs / 60000);
          const changeLabel = formatChangeStrategyIntervalForLog(cfg.changeStrategyIntervalMs);
          const priceCheckMin = Math.round(cfg.priceCheckIntervalMs / 60000);
          const message = `Demeter loops started in background (same as npm run demeter). Upkeep every ${pollMin} min, harvest every ${harvestMin} min, Float scheduled changeStrategy every ${changeLabel}, Float price check every ${priceCheckMin} min (m30 threshold ${cfg.priceDropThresholdPct}%).`;

          return JSON.stringify({
            success: true,
            message,
            pid: child.pid,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Failed to start Demeter",
          });
        }
      },
    },
  ]);
}