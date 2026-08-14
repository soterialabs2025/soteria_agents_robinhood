export type DemeterPublicLogStream = "strategy" | "pool";

export type DemeterConsoleChannelFilter = "out" | "err" | "all";

export type DemeterPublicConsoleLogEntry = {
  kind: "console";
  channel: "out" | "err";
  timestampUtc: string;
  /** PM2-style timestamp from the log line, e.g. `2026-06-07 04:34:20 +00:00`. */
  timestampDisplay?: string;
  message: string;
};

export type DemeterPublicStrategyLogEntry = {
  kind: "strategy";
  timestampUtc: string;
  timestampPacific: string;
  trigger: string;
  outcome: string;
  keeperPipeline?: string;
  changeSummary?: string | null;
  chosenSymbol: string | null;
  oldSymbol: string | null;
  changeStrategyTransaction: string | null;
};

export type DemeterPublicPoolLogEntry = {
  kind: "pool_value";
  timestampUtc: string;
  timestampPacific: string;
  poolValue: string;
};

export type DemeterPublicLogEntry = DemeterPublicStrategyLogEntry | DemeterPublicPoolLogEntry;

export type DemeterLogsApiResponse = {
  stream: DemeterPublicLogStream;
  publishDelayMs: number;
  entries: DemeterPublicLogEntry[];
  meta: {
    returned: number;
    limit: number;
    newestTimestampUtc: string | null;
  };
};

export type DemeterConsoleLogsApiResponse = {
  channel: DemeterConsoleChannelFilter;
  publishDelayMs: number;
  entries: DemeterPublicConsoleLogEntry[];
  /** Same shape as `pm2 logs demeter` for drop-in UI use. */
  lines: string[];
  meta: {
    returned: number;
    limit: number;
    newestTimestampUtc: string | null;
    debug?: {
      sources: Array<{
        channel: "out" | "err";
        path: string;
        readable: boolean;
        bytesRead: number;
        parsedLines: number;
      }>;
      withheldByPublishDelay: number;
    };
  };
};
