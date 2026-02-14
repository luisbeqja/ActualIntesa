const MAX_MESSAGE_LENGTH = 4000;

/**
 * Escapes HTML special characters for Telegram HTML parse mode
 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Formats an amount in cents as EUR string
 */
export function formatAmount(cents) {
  const euros = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "EUR",
  }).format(euros);
}

/**
 * Converts YYYY-MM-DD to DD/MM/YYYY
 */
export function formatDate(dateStr) {
  if (!dateStr || dateStr.length < 10) return dateStr || "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Truncates a message to fit Telegram's 4096 char limit
 */
export function truncate(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.slice(0, MAX_MESSAGE_LENGTH - 4) + "\n...";
}

/**
 * Builds the balance response message
 */
export function buildBalanceMessage(accounts) {
  if (accounts.length === 0) return "No accounts found.";

  let msg = "<b>Account Balances</b>\n\n";
  let onBudgetTotal = 0;

  for (const acc of accounts) {
    const balance = formatAmount(acc.balance);
    msg += `${escapeHtml(acc.name)}: <b>${escapeHtml(balance)}</b>\n`;
    if (acc.onBudget) onBudgetTotal += acc.balance;
  }

  msg += `\n<b>On-budget total:</b> ${escapeHtml(formatAmount(onBudgetTotal))}`;
  return truncate(msg);
}

/**
 * Builds the transactions list message
 */
export function buildTransactionsMessage(transactions, payeeMap, categoryMap) {
  if (transactions.length === 0) return "No transactions found.";

  let msg = `<b>Last ${transactions.length} Transactions</b>\n\n`;

  for (const tx of transactions) {
    const date = formatDate(tx.date);
    const amount = formatAmount(tx.amount);
    const payee = payeeMap.get(tx.payee) || "(unknown)";
    const category = categoryMap.get(tx.category) || "";
    const catStr = category ? ` [${escapeHtml(category)}]` : "";
    msg += `${escapeHtml(date)}  <b>${escapeHtml(amount)}</b>  ${escapeHtml(payee)}${catStr}\n`;
  }

  return truncate(msg);
}

/**
 * Builds the spending breakdown message
 */
export function buildSpendingMessage(month, categoryGroups, income, spent) {
  let msg = `<b>Spending for ${escapeHtml(month)}</b>\n\n`;
  msg += `Income: <b>${escapeHtml(formatAmount(income))}</b>\n`;
  msg += `Spent: <b>${escapeHtml(formatAmount(spent))}</b>\n\n`;

  for (const group of categoryGroups) {
    if (group.categories.length === 0) continue;
    msg += `<b>${escapeHtml(group.name)}</b>\n`;
    for (const cat of group.categories) {
      msg += `  ${escapeHtml(cat.name)}: ${escapeHtml(formatAmount(cat.spent))}\n`;
    }
    msg += "\n";
  }

  return truncate(msg);
}

/**
 * Builds the sync summary message
 */
export function buildSyncMessage({ fetched, imported, updated, skipped, errors, duration }) {
  let msg = "<b>Sync Complete</b>\n\n";
  msg += `Fetched: ${fetched}\n`;
  msg += `Imported: ${imported}\n`;
  msg += `Updated: ${updated}\n`;
  msg += `Skipped: ${skipped}\n`;
  msg += `Errors: ${errors}\n`;
  msg += `Duration: ${duration}s`;
  return msg;
}

/**
 * Builds the help message
 */
export function buildHelpMessage() {
  return (
    "<b>ActualIntesa Bot</b>\n\n" +
    "/sync - Sync bank transactions\n" +
    "/balance - Account balances\n" +
    "/transactions [N] - Recent transactions (default 10)\n" +
    "/spending [YYYY-MM] - Category spending breakdown\n" +
    "/help - Show this message"
  );
}
