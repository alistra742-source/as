export interface RecoverableManualResult {
  requestId: string;
  status: "accepted" | "succeeded" | "failed";
  message: string;
  at: number;
  postId?: string;
  postedAt?: number;
  url?: string;
}

/** A durable acknowledgement without a terminal receipt means the old process died. */
export function recoverInterruptedManualResult<T extends RecoverableManualResult>(
  result: T | null | undefined,
  at: number
): T | null | undefined {
  if (!result || result.status !== "accepted") return result;
  return {
    ...result,
    status: "failed",
    message: "The worker restarted after accepting this publish but before returning a success receipt. Nothing is confirmed as posted.",
    at,
  };
}
