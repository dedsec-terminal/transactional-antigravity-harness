const PERMISSION_DENIAL = /auto-denied|permission.*denied|no output produced/i;

export function classifyOutcome(result, terminal) {
  const status = terminal?.status ?? "MISSING_RESULT";
  const response = typeof terminal?.response === "string" ? terminal.response : "";
  // AGY >=1.1.28 may exit zero after --print-timeout with partial output.
  // Only inspect CLI stderr diagnostics, never words inside worker prose.
  const stderr = String(result.stderr ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  const timedOut = Boolean(result.timedOut) || stderr.split(/\r?\n/).some(line =>
    /\bwarning\b/i.test(line) && /print[- ]timeout|timed?\s*out|timeout\s+(?:reached|expired|exceeded)/i.test(line));
  const cliError = /^\s*error:/im.test(stderr);
  const permissionDenied = PERMISSION_DENIAL.test(
    `${result.stderr ?? ""}\n${terminal?.error ?? ""}\n${response}`,
  );
  const ok = !timedOut && !cliError
    && result.exitCode === 0
    && !permissionDenied
    && status === "SUCCESS"
    && response.trim().length > 0;
  const failureCode = timedOut ? 124 : permissionDenied ? 126 : cliError ? 1
    : (!terminal || result.exitCode !== 0 || status !== "SUCCESS" || !response.trim())
      ? (result.exitCode || 1) : null;
  return { ok, status, response, permissionDenied, failureCode, timedOut, cliError };
}
