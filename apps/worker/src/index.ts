import { parseServerConfig } from "@pwa/config";

parseServerConfig(process.env);

console.info("Worker ready");

await new Promise<void>((resolve) => {
  const keepAlive = setInterval(() => undefined, 60_000);
  const shutdown = () => {
    clearInterval(keepAlive);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    resolve();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});
