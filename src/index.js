import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runSetup } from "./setup.js";
import { runSync } from "./sync.js";

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
    "ENABLEBANKING_APP_ID",
    "ENABLEBANKING_KEY_PATH",
    "ENABLEBANKING_SESSION_ID",
    "ENABLEBANKING_ACCOUNT_ID",
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
  const isDryRun = process.argv.includes("--dry-run");

  // Setup takes priority over dry-run
  if (isSetupMode || !hasRequiredConfig()) {
    await runSetup();
  } else {
    await runSync({ dryRun: isDryRun });
  }
}

main().catch(error => {
  console.error("Error:", error.message);
  process.exit(1);
});
