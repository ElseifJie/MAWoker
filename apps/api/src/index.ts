import { parseServerConfig } from "@pwa/config";
import { buildApp } from "./app.js";

const config = parseServerConfig(process.env);
const app = buildApp();

await app.listen({ host: "0.0.0.0", port: config.port });
