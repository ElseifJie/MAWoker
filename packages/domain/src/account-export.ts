import { ResourceNotFoundError } from "./errors.js";

export interface AccountExportRepository {
  export(
    userId: string,
  ): PromiseLike<{ user: unknown } & Record<string, unknown>>;
}

export class AccountExportService {
  constructor(
    private readonly dependencies: {
      repository: AccountExportRepository;
      now?: () => Date;
    },
  ) {}

  async export(userId: string): Promise<Record<string, unknown>> {
    const data = await this.dependencies.repository.export(userId);
    if (!data.user) throw new ResourceNotFoundError();
    return {
      schemaVersion: "1",
      exportedAt: (this.dependencies.now?.() ?? new Date()).toISOString(),
      ...data,
    };
  }
}
