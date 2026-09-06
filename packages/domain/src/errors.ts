export class ResourceNotFoundError extends Error {
  readonly code = "RESOURCE_NOT_FOUND";

  constructor() {
    super("Resource not found");
    this.name = "ResourceNotFoundError";
  }
}
