#!/usr/bin/env node
import { runCli, runCleanups, EXIT, KEEP_RUNNING } from "./commands/run.js";

const STDIN_LIMIT_BYTES = 64 * 1024;

async function readStdin(): Promise<string> {
  // A password or credential value is small; an unbounded read would let a piped file exhaust memory.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += (chunk as Buffer).length;
    if (total > STDIN_LIMIT_BYTES) throw new Error(`standard input is larger than ${STDIN_LIMIT_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

let stopServer: (() => Promise<void>) | undefined;
/** Set by the handler for a one-shot command. If the command still finishes (embedded database work can hold the loop), the exit code stays the interrupt code, never 0. */
let interruptedExit: number = EXIT.ok;

/**
 * SIGINT and SIGTERM. A long-running command (serve, worker, demo) stops cleanly and exits 0: that is how it is
 * meant to end. A one-shot command (restore, export, migrate, admin create, ...) that is interrupted did NOT finish,
 * so it must not report success: clean up, say so, and exit 130 (SIGINT) or 143 (SIGTERM), like a shell does.
 */
const shutdown = (signal: "SIGINT" | "SIGTERM") => {
  if (stopServer) {
    void stopServer().finally(() => process.exit(EXIT.ok));
    return;
  }
  interruptedExit = signal === "SIGINT" ? EXIT.sigint : EXIT.sigterm;
  console.error(`changeradar: interrupted by ${signal}; the command did not finish`);
  void runCleanups().finally(() => process.exit(interruptedExit));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/** A closed output pipe (`changeradar ... | head`) ends the process quietly with 141, never with a domain code. */
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  process.exit(error.code === "EPIPE" ? EXIT.pipe : EXIT.internal);
});
process.stderr.on("error", () => process.exit(EXIT.pipe));

/** Anything that escapes is a defect: exit 70, which no documented outcome (0, 1, 2, 64, 66, 73) uses. */
const unexpected = (error: unknown) => {
  try {
    console.error(`changeradar: unexpected internal error (${error instanceof Error ? error.name : "unknown"}); this is a defect, not a usage or data problem`);
  } catch {
    /* stderr may be gone too */
  }
  process.exit(EXIT.internal);
};
process.on("uncaughtException", unexpected);
process.on("unhandledRejection", unexpected);

runCli(
  process.argv.slice(2),
  process.env,
  { out: (m) => console.log(m), err: (m) => console.error(m), stdin: readStdin },
  { onServer: (stop) => (stopServer = stop) },
).then((code) => {
  // One loop turn first, so a signal that arrived while the command held the loop is seen before the exit code is chosen.
  if (code !== KEEP_RUNNING) setImmediate(() => (process.exitCode = interruptedExit !== EXIT.ok ? interruptedExit : code));
}, unexpected);
