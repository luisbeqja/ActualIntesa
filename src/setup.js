import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as enablebanking from "./enablebanking.js";
import { validateConnection } from "./actual.js";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const envPath = join(projectRoot, ".env");

const CALLBACK_PORT = 3333;
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}/callback`;

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
  return answer.trim().replace(/^['"]|['"]$/g, "") || defaultValue;
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

    // Step 1: Enable Banking credentials
    console.log("Step 1: Enable Banking API Credentials");
    console.log("Register at: https://enablebanking.com/sign-in/");
    console.log("Then create an application in the Control Panel.\n");

    const appId = existingEnv.ENABLEBANKING_APP_ID ||
      await prompt(rl, "Enable Banking Application ID");

    let keyPath = existingEnv.ENABLEBANKING_KEY_PATH ||
      await prompt(rl, "Path to private key (.pem file)", `./${appId}.pem`);

    // Resolve relative path
    if (!keyPath.startsWith("/")) {
      keyPath = join(projectRoot, keyPath);
    }

    if (!existsSync(keyPath)) {
      console.error(`\nError: Private key file not found at: ${keyPath}`);
      console.error("Download it from the Enable Banking Control Panel when creating your application.");
      process.exit(1);
    }

    if (!appId) {
      console.error("Error: Enable Banking Application ID is required");
      process.exit(1);
    }

    // Step 2: Validate credentials
    console.log("\nValidating Enable Banking credentials...");
    try {
      await enablebanking.validateCredentials(appId, keyPath);
      console.log("✓ Enable Banking credentials valid\n");
    } catch (error) {
      console.error(`Error: ${error.message}`);
      console.error("Please check your Application ID and private key file.");
      process.exit(1);
    }

    // Step 3: Find Intesa San Paolo and start bank authorization
    console.log("Step 2: Bank Connection");
    console.log("Searching for Intesa San Paolo...");

    let banks;
    try {
      banks = await enablebanking.listBanks(appId, keyPath, "IT");
    } catch (error) {
      console.error(`Error listing banks: ${error.message}`);
      process.exit(1);
    }

    const intesa = banks.find(
      bank => bank.name.toLowerCase().includes("intesa") && bank.name.toLowerCase().includes("sanpaolo")
    );

    if (!intesa) {
      console.error("Error: Intesa San Paolo not found in available banks.");
      console.log("\nAvailable Italian banks:");
      banks.slice(0, 20).forEach(bank => console.log(`  - ${bank.name}`));
      if (banks.length > 20) console.log(`  ... and ${banks.length - 20} more`);
      process.exit(1);
    }

    console.log(`✓ Found: ${intesa.name}\n`);

    // Step 4: Start authorization flow
    console.log("Starting bank authorization...");

    let authResult;
    try {
      authResult = await enablebanking.startAuth(appId, keyPath, intesa.name, intesa.country, REDIRECT_URL);
    } catch (error) {
      console.error(`Error starting authorization: ${error.message}`);
      process.exit(1);
    }

    const authUrl = authResult.url;

    console.log("Opening bank authentication page in your browser...");
    console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

    // Start local server to receive callback BEFORE opening browser
    const callbackPromise = enablebanking.waitForCallback(CALLBACK_PORT);
    await openBrowser(authUrl);

    console.log("Complete bank authentication in your browser.");
    console.log("Waiting for authorization callback...\n");

    // Step 5: Wait for callback with authorization code
    let authCode;
    try {
      authCode = await callbackPromise;
      console.log("✓ Authorization code received\n");
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }

    // Step 6: Create session and get accounts
    console.log("Creating session...");

    let session;
    try {
      session = await enablebanking.createSession(appId, keyPath, authCode);
      console.log(`✓ Session created! Found ${session.accounts.length} account(s)\n`);
    } catch (error) {
      console.error(`Error creating session: ${error.message}`);
      process.exit(1);
    }

    // Step 7: Select account
    let accountId;
    if (session.accounts.length === 1) {
      accountId = session.accounts[0].uid;
      console.log(`Using account: ${accountId}`);
    } else {
      console.log("Multiple accounts found:");
      session.accounts.forEach((acc, idx) => {
        const iban = acc.identification_hashes?.find(h => h.scheme === "IBAN")?.hash || acc.uid;
        console.log(`  ${idx + 1}. ${acc.uid} (${iban})`);
      });

      const selection = await prompt(rl, `Select account (1-${session.accounts.length})`, "1");
      const selectionIdx = parseInt(selection) - 1;

      if (selectionIdx < 0 || selectionIdx >= session.accounts.length) {
        console.error("Invalid selection");
        process.exit(1);
      }

      accountId = session.accounts[selectionIdx].uid;
    }

    // Step 8: Save Enable Banking config
    // Store key path as relative to project root
    const relativeKeyPath = keyPath.startsWith(projectRoot)
      ? "./" + keyPath.slice(projectRoot.length + 1)
      : keyPath;

    saveEnvValues({
      ENABLEBANKING_APP_ID: appId,
      ENABLEBANKING_KEY_PATH: relativeKeyPath,
      ENABLEBANKING_SESSION_ID: session.session_id,
      ENABLEBANKING_ACCOUNT_ID: accountId,
    });

    console.log("\n✓ Enable Banking configuration saved to .env\n");

    // Step 9: Actual Budget configuration
    const isSetupMode = process.argv.includes("--setup");
    const needsActualSetup = isSetupMode ||
      !existingEnv.ACTUAL_SERVER_URL ||
      !existingEnv.ACTUAL_PASSWORD ||
      !existingEnv.ACTUAL_BUDGET_ID ||
      !existingEnv.ACTUAL_ACCOUNT_ID;

    if (needsActualSetup) {
      console.log("Step 3: Actual Budget Configuration\n");

      let actualValid = false;
      let actualServerUrl, actualPassword, actualBudgetId, actualAccountId;

      while (!actualValid) {
        actualServerUrl = await prompt(
          rl,
          "Actual Budget Server URL",
          existingEnv.ACTUAL_SERVER_URL || "http://localhost:5006"
        );

        actualPassword = await prompt(
          rl,
          "Actual Budget Password",
          existingEnv.ACTUAL_PASSWORD || ""
        );

        console.log("\nFind your Budget Sync ID in: Actual Budget → Settings → Advanced → Sync ID");
        actualBudgetId = await prompt(
          rl,
          "Budget Sync ID",
          existingEnv.ACTUAL_BUDGET_ID || ""
        );

        console.log("Find your Account ID in the URL when viewing the account in Actual Budget");
        actualAccountId = await prompt(
          rl,
          "Account ID",
          existingEnv.ACTUAL_ACCOUNT_ID || ""
        );

        if (!actualServerUrl || !actualPassword || !actualBudgetId || !actualAccountId) {
          console.error("\nError: All Actual Budget fields are required\n");
          continue;
        }

        // Validate connection
        console.log("\nValidating Actual Budget connection...");
        try {
          await validateConnection(actualServerUrl, actualPassword, actualBudgetId, actualAccountId);
          console.log("✓ Actual Budget connection valid\n");
          actualValid = true;
        } catch (error) {
          console.error(`\nError: ${error.message}\n`);
          console.log("Please check your credentials and try again.\n");
        }
      }

      // Save Actual Budget config
      saveEnvValues({
        ACTUAL_SERVER_URL: actualServerUrl,
        ACTUAL_PASSWORD: actualPassword,
        ACTUAL_BUDGET_ID: actualBudgetId,
        ACTUAL_ACCOUNT_ID: actualAccountId,
      });

      console.log("✓ Actual Budget configuration saved to .env\n");
    }

    // Final confirmation
    const finalEnv = loadEnvValues();
    console.log("=== Setup Complete! ===\n");
    console.log(`✓ Enable Banking: Connected (Account: ${finalEnv.ENABLEBANKING_ACCOUNT_ID})`);
    console.log(`✓ Actual Budget: Connected (Budget: ${finalEnv.ACTUAL_BUDGET_ID})\n`);
    console.log("Run again to sync transactions. (coming in next update)");

  } catch (error) {
    console.error(`\nSetup failed: ${error.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}
