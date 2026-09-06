import { ResourceNotFoundError } from "./errors.js";

export { ResourceNotFoundError } from "./errors.js";

export type TenantResourceKind =
  | "personalAgent"
  | "platformAgent"
  | "session"
  | "sessionInput"
  | "artifact"
  | "usage";

export interface TenantResource {
  id: string;
}

interface OwnedResourceRepository {
  findOwned(
    currentUserId: string,
    resourceId: string,
  ): PromiseLike<TenantResource | undefined>;
}

export interface TenantAuthorizationRepositories {
  personalAgents: OwnedResourceRepository;
  platformAgents: {
    findAssignedToUser(
      currentUserId: string,
      platformAgentId: string,
    ): PromiseLike<TenantResource | undefined>;
  };
  sessions: OwnedResourceRepository;
  sessionInputs: OwnedResourceRepository;
  artifacts: OwnedResourceRepository;
  usage: OwnedResourceRepository;
}

export class TenantAuthorizationService {
  constructor(private readonly repositories: TenantAuthorizationRepositories) {}

  async resolve(
    kind: TenantResourceKind,
    resourceId: string,
    currentUserId: string,
  ): Promise<TenantResource> {
    const resource =
      kind === "platformAgent"
        ? await this.repositories.platformAgents.findAssignedToUser(
            currentUserId,
            resourceId,
          )
        : await this.repositories[this.ownedRepository(kind)].findOwned(
            currentUserId,
            resourceId,
          );

    if (!resource) {
      throw new ResourceNotFoundError();
    }
    return resource;
  }

  private ownedRepository(
    kind: Exclude<TenantResourceKind, "platformAgent">,
  ): Exclude<keyof TenantAuthorizationRepositories, "platformAgents"> {
    const repositories = {
      personalAgent: "personalAgents",
      session: "sessions",
      sessionInput: "sessionInputs",
      artifact: "artifacts",
      usage: "usage",
    } as const;
    return repositories[kind];
  }
}

export * from "./platform-agents.js";
export * from "./session-inputs.js";
export * from "./sessions.js";
export * from "./user-agents.js";
