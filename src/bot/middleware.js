/**
 * Auth guard middleware — rejects messages from non-owner chat IDs
 * @param {string} chatId - Authorized Telegram chat ID
 * @returns {Function} Telegraf middleware
 */
export function authGuard(chatId) {
  return (ctx, next) => {
    if (String(ctx.chat?.id) !== String(chatId)) {
      return ctx.reply("Unauthorized.");
    }
    return next();
  };
}

/**
 * Wraps an async handler to keep the "typing..." indicator alive
 * @param {Object} ctx - Telegraf context
 * @param {Function} fn - Async function to execute
 */
export async function withTyping(ctx, fn) {
  const interval = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {});
  }, 4000);

  try {
    await ctx.sendChatAction("typing");
    return await fn();
  } finally {
    clearInterval(interval);
  }
}

/**
 * Maps known errors to user-friendly messages
 * @param {Error} error
 * @returns {string}
 */
export function friendlyError(error) {
  const msg = error.message || "";
  if (msg.toLowerCase().includes("session") || msg.includes("401") || msg.includes("403")) {
    return "Enable Banking session expired. Run the CLI setup again.";
  }
  if (msg.includes("ECONNREFUSED")) {
    return "Cannot connect to Actual Budget server. Is it running?";
  }
  if (msg.includes("Budget not found")) {
    return "Budget not found. Check ACTUAL_BUDGET_ID.";
  }
  return `Error: ${msg}`;
}
