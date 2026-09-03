/**
 * In-process log rotation for the daemon's own log file.
 *
 * Replaces a bash subshell that used to poll the log's size on a timer and
 * truncate it in place — the exact mechanism that could orphan itself
 * forever if the supervisor died without running its trap. Doing this
 * inside the daemon's own event loop instead removes that failure mode by
 * construction: there is no longer a second process that can outlive its
 * parent, because there is no second process. The daemon's stdout is opened
 * in append mode by whatever supervises it (launchd/systemd/the fallback
 * loop), so truncating the file in place (not through the stdout fd) keeps
 * that fd valid for the next write — the same copytruncate trick the old
 * bash version relied on.
 */

/** Whether the log has grown past the per-file cap and needs rotating. */
export function needsRotation(currentSize: number, maxBytes: number): boolean {
  return currentSize > maxBytes;
}

/** The bytes to keep as the new backup: the last `maxBytes` of `content` (mirrors `tail -c`). */
export function backupTail(content: Buffer, maxBytes: number): Buffer {
  return content.length <= maxBytes ? content : content.subarray(content.length - maxBytes);
}
