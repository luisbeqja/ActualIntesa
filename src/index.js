import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runSetup } from "./setup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const envPath = join(projectRoot, ".env");

/**
 * Checks if .env file exists and has required values
 * @returns {boolean} True if all required config exists
 */
function hasRequiredConfig() {
  if (!existsSync(envPath)) {
    return false;
  }

  const content = readFileSync(envPath, "utf-8");
  const requiredKeys = [
    "GOCARDLESS_SECRET_ID",
    "GOCARDLESS_SECRET_KEY",
    "GOCARDLESS_REQUISITION_ID",
    "GOCARDLESS_ACCOUNT_ID",
    "ACTUAL_SERVER_URL",
    "ACTUAL_PASSWORD",
    "ACTUAL_BUDGET_ID",
    "ACTUAL_ACCOUNT_ID",
  ];

  return requiredKeys.every(key => {
    const regex = new RegExp(`^${key}=.+$`, "m");
    return regex.test(content);
  });
}

/**
 * Main entry point
 */
async function main() {
  const isSetupMode = process.argv.includes("--setup");

  if (isSetupMode || !hasRequiredConfig()) {
    await runSetup();
  } else {
    console.log("Setup complete. Configuration found in .env");
    console.log("Run with --setup to reconfigure.");
    console.log("\n(Transaction sync will be added in Phase 2)");
  }
}

main().catch(error => {
  console.error("Error:", error.message);
  process.exit(1);
});
