import api from "@actual-app/api";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

/**
 * Validates connection to Actual Budget server
 * @param {string} serverUrl - Actual Budget server URL
 * @param {string} password - Actual Budget password
 * @param {string} budgetId - Budget sync ID
 * @param {string} accountId - Account ID to verify
 * @returns {Promise<boolean>} True if connection is valid
 * @throws {Error} If connection fails with descriptive error message
 */
export async function validateConnection(serverUrl, password, budgetId, accountId) {
  try {
    // Initialize API with server connection
    await api.init({
      dataDir: join(projectRoot, "actual-data"),
      serverURL: serverUrl,
      password: password,
    });

    // Download budget to verify budget ID is valid
    try {
      await api.downloadBudget(budgetId);
    } catch (error) {
      await api.shutdown();
      if (error.message?.includes("404") || error.message?.includes("not found")) {
        throw new Error(`Budget not found. Check your Budget Sync ID in Actual Budget → Settings → Advanced`);
      }
      throw new Error(`Failed to download budget: ${error.message}`);
    }

    // Get accounts and verify account ID exists
    const accounts = await api.getAccounts();

    if (!accounts || accounts.length === 0) {
      await api.shutdown();
      throw new Error("No accounts found in budget");
    }

    const accountExists = accounts.some(acc => acc.id === accountId);

    if (!accountExists) {
      await api.shutdown();
      const accountList = accounts.map(acc => `  - ${acc.name} (${acc.id})`).join("\n");
      throw new Error(
        `Account ID "${accountId}" not found in budget.\n\nAvailable accounts:\n${accountList}\n\nFind the account ID in the URL when viewing the account in Actual Budget.`
      );
    }

    // Clean up
    await api.shutdown();

    return true;
  } catch (error) {
    // Handle specific connection errors
    if (error.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot connect to Actual Budget server at ${serverUrl}. Is the server running?`
      );
    }

    if (error.message?.includes("401") || error.message?.includes("Unauthorized")) {
      throw new Error("Invalid password. Check your Actual Budget server password.");
    }

    // Re-throw if already a formatted error
    if (error.message?.includes("Budget not found") ||
        error.message?.includes("Account ID") ||
        error.message?.includes("Cannot connect")) {
      throw error;
    }

    // Generic error
    throw new Error(`Actual Budget connection failed: ${error.message}`);
  }
}
