import { createServer } from "node:http";

export function startWorkerLivenessServer(options: {
  host: string;
  port: number;
}) {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health/live") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"live"}');
  });
  server.listen(options.port, options.host);

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
