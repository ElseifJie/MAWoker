export interface WorkerProcessor {
  runOnce(): PromiseLike<number>;
}

export async function runWorkerPoll(
  processors: readonly WorkerProcessor[],
  reportError: (message: string, error: unknown) => void = console.error,
): Promise<void> {
  for (const processor of processors) {
    try {
      await processor.runOnce();
    } catch (error) {
      reportError("Worker processor poll failed", error);
    }
  }
}

export function runProductionWorkerPoll(
  processors: {
    personalAgent: WorkerProcessor;
    session: WorkerProcessor;
    sessionDeletion: WorkerProcessor;
    usage: WorkerProcessor;
    quotaInterrupt: WorkerProcessor;
    uploadCleanup: WorkerProcessor;
    artifactDeletion: WorkerProcessor;
    artifactCleanup: WorkerProcessor;
    driveCleanup: WorkerProcessor;
    driveOrphanGc: WorkerProcessor;
    history?: WorkerProcessor;
    memory?: WorkerProcessor;
    delivery?: WorkerProcessor;
  },
  reportError?: (message: string, error: unknown) => void,
): Promise<void> {
  return runWorkerPoll(
    [
      processors.personalAgent,
      processors.session,
      ...(processors.delivery ? [processors.delivery] : []),
      processors.sessionDeletion,
      processors.usage,
      ...(processors.history ? [processors.history] : []),
      processors.quotaInterrupt,
      processors.uploadCleanup,
      processors.artifactDeletion,
      processors.artifactCleanup,
      processors.driveCleanup,
      processors.driveOrphanGc,
      ...(processors.memory ? [processors.memory] : []),
    ],
    reportError,
  );
}
