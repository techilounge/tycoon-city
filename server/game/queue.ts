/**
 * Per-game submission queue (spec "Server core"): commands run one at a time
 * per game, so applyCommand never sees concurrent state. Deadline commands
 * (Phase 2 PR 15) enter the same queue as player commands, which is exactly
 * what makes deadline-vs-player races impossible.
 */
export class SubmitQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Chain `task` after every previously pushed task, regardless of their outcomes. */
  push<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(task, task) as Promise<T>;
    // Keep the chain alive on rejection; the caller still sees `run` reject.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
