const PERMISSION_DENIAL = /auto-denied|permission.*denied|no output produced/i;

export function classifyOutcome(result, terminal) {
  const status = terminal?.status ?? "MISSING_RESULT";
  const response = typeof terminal?.response === "string" ? terminal.response : "";
  const permissionDenied = PERMISSION_DENIAL.test(
    `${result.stderr ?? ""}\n${terminal?.error ?? ""}\n${response}`,
  );
  const ok = !result.timedOut
    && result.exitCode === 0
    && !permissionDenied
    && status === "SUCCESS"
    && response.trim().length > 0;
  const failureCode = result.timedOut ? 124 : permissionDenied ? 126
    : (!terminal || result.exitCode !== 0 || status !== "SUCCESS" || !response.trim())
      ? (result.exitCode || 1) : null;
  return { ok, status, response, permissionDenied, failureCode };
}
