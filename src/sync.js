import { getTransactions } from "./enablebanking.js";
import { importTransactions } from "./actual.js";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const envPath = join(projectRoot, ".env");

/**
 * Updates or adds a value to .env file
 * @param {string} key - Environment variable key
 * @param {string} value - Environment variable value
 */
function updateEnvValue(key, value) {
  let content = "";

  if (readFileSync(envPath, "utf-8")) {
    content = readFileSync(envPath, "utf-8");
  }

  const regex = new RegExp(`^${key}=.*$`, "m");

  if (regex.test(content)) {
    // Update existing key
    content = content.replace(regex, `${key}=${value}`);
  } else {
    // Add new key
    content = content.trim() + `\n${key}=${value}\n`;
  }

  writeFileSync(envPath, content, "utf-8");
}

/**
 * Maps an Enable Banking transaction to Actual Budget format
 * @param {Object} tx - Enable Banking transaction object
 * @returns {Object} Actual Budget transaction format
 */
function mapTransaction(tx) {
  // Date: use first available
  const date = tx.booking_date || tx.value_date || tx.transaction_date;

  // Amount: convert to cents integer with correct sign
  let amount = parseFloat(tx.transaction_amount?.amount || 0);
  amount = Math.round(amount * 100);

  // Apply sign based on credit/debit indicator
  if (tx.credit_debit_indicator === "DBIT") {
    amount = -Math.abs(amount);
  } else if (tx.credit_debit_indicator === "CRDT") {
    amount = Math.abs(amount);
  }
  // If no indicator, use the sign as-is from Enable Banking

  // Payee: creditor name for credits, debtor name for debits, fallback to remittance
  let payee_name = "";
  if (tx.credit_debit_indicator === "CRDT" && tx.creditor?.name) {
    payee_name = tx.creditor.name;
  } else if (tx.credit_debit_indicator === "DBIT" && tx.debtor?.name) {
    payee_name = tx.debtor.name;
  } else if (tx.remittance_information && tx.remittance_information.length > 0) {
    payee_name = tx.remittance_information[0];
  }

  // Notes: combine remittance info and transaction code description
  let notes = "";
  if (tx.bank_transaction_code?.description) {
    notes = tx.bank_transaction_code.description;
  }
  if (tx.remittance_information && tx.remittance_information.length > 0) {
    const remittanceText = tx.remittance_information.join(" ");
    notes = notes ? `${notes} - ${remittanceText}` : remittanceText;
  }

  // Imported ID: for duplicate detection
  const imported_id = tx.transaction_id || tx.entry_reference;

  // Cleared: booked transactions are cleared, pending are not
  const cleared = tx.status === "BOOK";

  return {
    date,
    amount,
    payee_name,
    notes,
    imported_id,
    cleared,
  };
}

/**
 * Runs the full transaction sync flow
 */
export async function runSync() {
  // Read config from environment
  const appId = process.env.ENABLEBANKING_APP_ID;
  const keyPath = process.env.ENABLEBANKING_KEY_PATH;
  const sessionId = process.env.ENABLEBANKING_SESSION_ID;
  const ebAccountId = process.env.ENABLEBANKING_ACCOUNT_ID;
  const serverUrl = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;
  const budgetId = process.env.ACTUAL_BUDGET_ID;
  const actualAccountId = process.env.ACTUAL_ACCOUNT_ID;

  // Determine date range
  const lastSyncDate = process.env.LAST_SYNC_DATE;
  let dateFrom;

  if (lastSyncDate) {
    dateFrom = lastSyncDate;
  } else {
    // First run: 90 days ago
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    dateFrom = ninetyDaysAgo.toISOString().split("T")[0]; // YYYY-MM-DD
  }

  const dateTo = new Date().toISOString().split("T")[0]; // Today

  console.log(`\nSyncing transactions from ${dateFrom} to ${dateTo}...`);

  // Fetch transactions from Enable Banking
  let transactions;
  try {
    transactions = await getTransactions(appId, keyPath, ebAccountId, dateFrom, dateTo);
  } catch (error) {
    // Check for session/auth errors
    if (error.message.toLowerCase().includes("session") ||
        error.message.includes("401") ||
        error.message.includes("403")) {
      console.error("\nEnable Banking session expired or invalid. Run with --setup to reconnect.");
      process.exit(1);
    }
    throw error;
  }

  console.log(`Fetched ${transactions.length} transactions from Enable Banking (${dateFrom} to ${dateTo})`);

  // Map transactions to Actual Budget format
  const mappedTransactions = transactions.map(mapTransaction);

  // Import to Actual Budget
  const result = await importTransactions(serverUrl, password, budgetId, actualAccountId, mappedTransactions);

  console.log(`Imported: ${result.added?.length || 0} new, ${result.updated?.length || 0} updated`);

  // Log errors if any
  if (result.errors && result.errors.length > 0) {
    console.error("\nImport errors:");
    result.errors.forEach(err => console.error(`  - ${err}`));
  }

  // Save last sync date to .env
  updateEnvValue("LAST_SYNC_DATE", dateTo);
  console.log(`\nSync complete. Last sync date saved: ${dateTo}`);
}
