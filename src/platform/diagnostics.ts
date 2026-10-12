import { redactDeep } from "../domain/redaction.js";

/**
 * Local diagnostics contain classifications and opaque correlation ids, never raw errors, request
 * bodies, headers or query strings. Every entry additionally passes through the domain redactor.
 */
export interface DiagnosticEvent {
  event: string;
  level: "info" | "warn" | "error";
  request_id?: string;
  operation?: string;
  method?: string;
  status?: number;
  duration_ms?: number;
  code?: string;
  job_id?: string;
  run_id?: string;
}
export type DiagnosticSink = (entry: DiagnosticEvent) => void;

export const emitDiagnostic: DiagnosticSink = (entry) => {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...(redactDeep(entry) as object) })}\n`);
};

/** Warnings and errors are always emitted; info-level request logging is opt-in (CHANGERADAR_LOG=1). */
export const diagnosticsFor = (logRequests: boolean): DiagnosticSink => (entry) => {
  if (entry.level === "info" && !logRequests) return;
  emitDiagnostic(entry);
};

export const silentDiagnostics: DiagnosticSink = () => undefined;
