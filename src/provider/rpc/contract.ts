import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PiDiagnosticsReport } from "../runner/diagnostics-types.ts";

export const rpcContract = defineRpcContract({
  diagnostics_get: {
    input: z.object({}).optional(),
    output: z.object({
      report: z.custom<PiDiagnosticsReport>(),
    }),
  },
});

export type PiRpcContract = typeof rpcContract;
