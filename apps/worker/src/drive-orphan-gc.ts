interface DriveOrphanGcService {
  reapOrphans(input: {
    limit: number;
    retentionMs: number;
  }): PromiseLike<number>;
}

/**
 * Finds drive objects that nothing references any more and enqueues cleanup for
 * them. Kept separate from the cleanup processor so the scan cadence and the
 * delete cadence can differ, and so a backlog of deletes never starves the scan.
 *
 * The retention window is where "delete with the Session" lives: at the default
 * of zero an orphan is reaped on the next scan, matching the phase-1 promise
 * that deleting a Session removes its artifacts. Raising it makes files linger
 * in a user's drive instead — the behaviour a drive mode wants — without any
 * change to the deletion saga.
 */
export class DriveOrphanGcProcessor {
  constructor(
    private readonly dependencies: {
      service: DriveOrphanGcService;
      retentionMs: number;
      batchSize?: number;
    },
  ) {}

  async runOnce(): Promise<number> {
    return this.dependencies.service.reapOrphans({
      limit: this.dependencies.batchSize ?? 50,
      retentionMs: this.dependencies.retentionMs,
    });
  }
}
