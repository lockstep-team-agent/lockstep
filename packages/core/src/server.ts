import { buildApp } from "./api/app.js";
import { env } from "./env.js";

const app = buildApp();

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`lockstep-core listening on :${env.PORT} (${env.LOCKSTEP_DEPLOYMENT})`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
