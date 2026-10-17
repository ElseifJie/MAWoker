export class AccountAlreadyDeletedError extends Error {
  readonly code = "ACCOUNT_ALREADY_DELETED";
  constructor() {
    super("The account is already deleted");
    this.name = "AccountAlreadyDeletedError";
  }
}

export interface AccountDeletionRepository {
  deleteOwnAccount(userId: string, now: Date): PromiseLike<boolean>;
}

export class AccountDeletionService {
  constructor(
    private readonly dependencies: {
      repository: AccountDeletionRepository;
      now?: () => Date;
    },
  ) {}

  async delete(userId: string): Promise<void> {
    const deleted = await this.dependencies.repository.deleteOwnAccount(
      userId,
      this.dependencies.now?.() ?? new Date(),
    );
    if (!deleted) throw new AccountAlreadyDeletedError();
  }
}
