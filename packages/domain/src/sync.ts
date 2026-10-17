export interface SyncChangeRecord {
  seq: number;
  resourceType: string;
  resourceId: string;
  revision: number | null;
  deleted: boolean;
  changedAt: Date;
}

export interface SyncChangePage {
  changes: SyncChangeRecord[];
  hasMore: boolean;
}

export interface SyncRepository {
  getCursor(ownerUserId: string): PromiseLike<number>;
  listChanges(
    ownerUserId: string,
    cursor: number,
    limit: number,
  ): PromiseLike<SyncChangePage>;
}

export interface SyncRunSource {
  listForOwner(ownerUserId: string, limit: number): PromiseLike<unknown[]>;
}

export interface SyncNotificationSource {
  listNotifications(ownerUserId: string, limit: number): PromiseLike<unknown[]>;
}

/**
 * Account-level sync. The snapshot is a state read at a watermark; changes are
 * hints carrying (type, id, revision), so a client refetches the authoritative
 * resource instead of trusting a diff. A cursor past the retained window must
 * be recovered by taking a fresh snapshot.
 */
export class SyncService {
  constructor(
    private readonly dependencies: {
      repository: SyncRepository;
      runs: SyncRunSource;
      notifications: SyncNotificationSource;
    },
  ) {}

  async snapshot(userId: string) {
    const cursor = await this.dependencies.repository.getCursor(userId);
    const [runs, notifications] = await Promise.all([
      this.dependencies.runs.listForOwner(userId, 50),
      this.dependencies.notifications.listNotifications(userId, 50),
    ]);
    return {
      cursor,
      resources: { runs, notifications },
    };
  }

  async changes(userId: string, cursor: number, limit: number) {
    const page = await this.dependencies.repository.listChanges(
      userId,
      cursor,
      limit,
    );
    const last = page.changes.at(-1);
    return {
      cursor: last ? last.seq : cursor,
      hasMore: page.hasMore,
      changes: page.changes,
    };
  }
}
