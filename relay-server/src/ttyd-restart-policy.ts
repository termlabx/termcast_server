/**
 * Decide whether the relay must recover after the local termcastd (ttyd)
 * process exits.
 *
 * termcastd is the terminal backend the bridge connects to on 127.0.0.1:7681.
 * If it dies for ANY reason while we are still serving, the relay can no longer
 * bridge terminal traffic: the phone still pairs with the relay (shows
 * "connected") but no terminal ever opens, and the relay loops forever on
 * `Cannot connect to local termcastd`. Recovering (exit → supervisor respawns
 * the relay, which spawns a fresh termcastd) is the only way out.
 *
 * The exit code / signal deliberately do NOT gate recovery. A graceful SIGTERM
 * makes ttyd shut down cleanly with code 0 and a null signal; earlier logic
 * only recovered on `(code !== 0) || signal`, so that exact case silently left
 * the relay running against a dead backend. The one time we must NOT recover is
 * our own shutdown, where we stop termcastd intentionally via `ttyd.stop()`.
 */
export function shouldRecoverFromTtydExit(opts: {
  shuttingDown: boolean;
  code: number | null;
  signal: string | null;
}): boolean {
  return !opts.shuttingDown;
}
