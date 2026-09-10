import type { ChildProcess } from 'node:child_process';
export interface TerminateOwnedProcessOptions {
  child?: ChildProcess;
  pid?: number;
  platform?: NodeJS.Platform | string;
  gracePeriodMs?: number;
  pollIntervalMs?: number;
  commandRunner?: (request: { command: string; args: string[]; timeoutMs: number; windowsHide?: boolean }) => Promise<{ exitCode?: number; status?: number; timedOut?: boolean }>;
}
export function terminateOwnedProcessTree(input?: ChildProcess | TerminateOwnedProcessOptions): Promise<{ stopped: boolean; method?: string; reason?: string; pid?: number; exitCode?: number }>;
