import { parseServerConfig } from "@pwa/config";

const config = parseServerConfig(process.env);
const { buildApp } = await import("./app.js");
const app = buildApp({ isProduction: config.nodeEnv === "production" });

await app.listen({ host: "0.0.0.0", port: config.port });
