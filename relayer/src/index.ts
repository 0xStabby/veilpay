import path from "path";
import dotenv from "dotenv";
import { app } from "./app";

const relayerEnv = process.env.RELAYER_ENV || process.env.NODE_ENV;
const envFile = relayerEnv === "dev" ? ".env.dev" : ".env";
dotenv.config({ path: path.resolve(__dirname, "..", envFile) });

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`relayer listening on ${port}`);
});
