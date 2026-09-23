import { bitqueryAuthFromEnv } from "./bitqueryAuth";
import { BitqueryTransferSource } from "./bitqueryTransferSource";

const LOOKBACK_SECONDS = 3_600;
const FINALITY_LAG_SECONDS = 300;

/** Read-only prelaunch check of OAuth/API access and the realtime history window. */
export async function probeBitqueryLaunchReadiness(
  source: Pick<BitqueryTransferSource, "probeCoverage"> = new BitqueryTransferSource(bitqueryAuthFromEnv()),
  nowMs = Date.now(),
): Promise<void> {
  if (!Number.isSafeInteger(nowMs) || nowMs <= LOOKBACK_SECONDS * 1_000) throw new Error("BITQUERY_READINESS_TIME_INVALID");
  const nowSeconds = Math.floor(nowMs / 1_000);
  await source.probeCoverage(nowSeconds - LOOKBACK_SECONDS, nowSeconds - FINALITY_LAG_SECONDS);
}
