import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { app } from "./app";

const modeFlagIndex = process.argv.findIndex((arg) => arg === "--mode");
const modeFlagValue =
  modeFlagIndex >= 0 ? process.argv[modeFlagIndex + 1] : undefined;
const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const mode = modeArg ? modeArg.split("=")[1] : modeFlagValue;
const relayerEnv = mode || process.env.RELAYER_ENV || process.env.NODE_ENV;
let envFile = ".env";
if (relayerEnv === "devnet") {
  envFile = ".env.devnet";
} else if (relayerEnv === "localnet") {
  const localnetPath = path.resolve(__dirname, "..", ".env.localnet");
  if (fs.existsSync(localnetPath)) {
    envFile = ".env.localnet";
  }
}
const envPath = path.resolve(__dirname, "..", envFile);
dotenv.config({ path: envPath });
console.log(`[relayer] env file: ${envFile}`);
console.log(`[relayer] env path: ${envPath}`);
console.log(`[relayer] RELAYER_KEYPAIR: ${process.env.RELAYER_KEYPAIR ?? "(unset)"}`);

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`relayer listening on ${port}`);
});
