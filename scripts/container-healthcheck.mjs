import process from "node:process";

const role = process.argv[2] ?? process.env.PROCESS_ROLE ?? "api";
const worker = role === "worker";
const port = worker
  ? (process.env.WORKER_HEALTH_PORT ?? "3001")
  : (process.env.PORT ?? "3000");
const path = worker ? "/health/live" : "/health/ready";

try {
  const response = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
    signal: globalThis.AbortSignal.timeout(2_000),
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
