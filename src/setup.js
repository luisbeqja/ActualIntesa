import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as gocardless from "./gocardless.js";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const envPath = join(projectRoot, ".env");

/**
 * Loads existing .env values
 * @returns {Object} Key-value pairs from .env
 */
function loadEnvValues() {
  if (!existsSync(envPath)) {
    return {};
  }

  const content = readFileSync(envPath, "utf-8");
  const values = {};

  content.split("\n").forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key) {
        values[key.trim()] = valueParts.join("=").trim();
      }
    }
  });

  return values;
}

/**
 * Saves values to .env file
 * @param {Object} newValues - Key-value pairs to save/update
 */
function saveEnvValues(newValues) {
  const existingValues = loadEnvValues();
  const mergedValues = { ...existingValues, ...newValues };

  const lines = Object.entries(mergedValues)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  writeFileSync(envPath, lines + "\n", "utf-8");
}

/**
 * Opens a URL in the default browser
 * @param {string} url - URL to open
 */
async function openBrowser(url) {
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      await execAsync(`open "${url}"`);
    } else if (platform === "linux") {
      await execAsync(`xdg-open "${url}"`);
    } else if (platform === "win32") {
      await execAsync(`start "${url}"`);
    }
  } catch (error) {
    // Browser opening failed - URL is still printed as fallback
  }
}

/**
 * Prompts user for input
 * @param {Object} rl - Readline interface
 * @param {string} question - Question to ask
 * @param {string} defaultValue - Default value
 * @returns {Promise<string>} User input or default
 */
async function prompt(rl, question, defaultValue = "") {
  const displayDefault = defaultValue ? ` (default: ${defaultValue})` : "";
  const answer = await rl.question(`${question}${displayDefault}: `);
  return answer.trim() || defaultValue;
}

/**
 * Runs the interactive setup flow
 */
export async function runSetup() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n=== ActualIntesa Setup ===\n");

    const existingEnv = loadEnvValues();

    // Step 1: GoCardless credentials
    console.log("Step 1: GoCardless API Credentials");
    console.log("Get these from: https://bankaccountdata.gocardless.com → User secrets\n");

    const secretId = existingEnv.GOCARDLESS_SECRET_ID ||
      await prompt(rl, "GoCardless Secret ID");
    const secretKey = existingEnv.GOCARDLESS_SECRET_KEY ||
      await prompt(rl, "GoCardless Secret Key");

    if (!secretId || !secretKey) {
      console.error("Error: GoCardless credentials are required");
      process.exit(1);
    }

    // Step 2: Create GoCardless client and validate credentials
    console.log("\nValidating GoCardless credentials...");
    let client;
    try {
      client = await gocardless.createClient(secretId, secretKey);
      console.log("✓ GoCardless credentials valid\n");
    } catch (error) {
      console.error(`Error: ${error.message}`);
      console.error("Please check your credentials and try again.");
      process.exit(1);
    }

    // Step 3: Create requisition for Intesa San Paolo
    console.log("Step 2: Bank Connection");
    console.log("Creating requisition for Intesa San Paolo...");

    let requisitionId;
    let authLink;

    try {
      const requisition = await gocardless.createRequisition(client);
      requisitionId = requisition.requisitionId;
      authLink = requisition.link;

      console.log("✓ Requisition created\n");
      console.log("Opening bank authentication page in your browser...");
      console.log(`If browser doesn't open, visit: ${authLink}\n`);

      await openBrowser(authLink);

      console.log("Complete bank authentication in your browser.");
      await rl.question("Press Enter when you've completed authentication...");

    } catch (error) {
      console.error(`Error creating requisition: ${error.message}`);
      process.exit(1);
    }

    // Step 4: Wait for requisition to be linked
    console.log("\nWaiting for bank authentication...");

    let accounts;
    try {
      accounts = await gocardless.waitForRequisition(client, requisitionId);
      console.log(`✓ Bank authentication complete! Found ${accounts.length} account(s)\n`);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }

    // Step 5: Select account (or auto-select if only one)
    let accountId;
    if (accounts.length === 1) {
      accountId = accounts[0];
      console.log(`Using account: ${accountId}`);
    } else {
      console.log("Multiple accounts found:");
      accounts.forEach((acc, idx) => {
        console.log(`  ${idx + 1}. ${acc}`);
      });

      const selection = await prompt(rl, `Select account (1-${accounts.length})`, "1");
      const selectionIdx = parseInt(selection) - 1;

      if (selectionIdx < 0 || selectionIdx >= accounts.length) {
        console.error("Invalid selection");
        process.exit(1);
      }

      accountId = accounts[selectionIdx];
    }

    // Step 6: Save GoCardless config
    saveEnvValues({
      GOCARDLESS_SECRET_ID: secretId,
      GOCARDLESS_SECRET_KEY: secretKey,
      GOCARDLESS_REQUISITION_ID: requisitionId,
      GOCARDLESS_ACCOUNT_ID: accountId,
    });

    console.log("\n✓ GoCardless configuration saved to .env\n");

    console.log("Setup complete! GoCardless connection established.");

  } catch (error) {
    console.error(`\nSetup failed: ${error.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}
