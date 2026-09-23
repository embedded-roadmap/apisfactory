import { buildApp } from "./app";
import { config } from "./config";

const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: "0.0.0.0" });
