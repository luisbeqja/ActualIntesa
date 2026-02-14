import { getTransactions } from "../enablebanking.js";
import { mapTransaction } from "../sync.js";
import { importTransactions } from "../actual.js";
import { withActual } from "./actual-query.js";
import { requireUser, requireAdmin, withTyping, friendlyError } from "./middleware.js";
import { updateUser, createInviteCode, listUsers, deleteUser } from "../db.js";
import {
  buildBalanceMessage,
  buildTransactionsMessage,
  buildSpendingMessage,
  buildSyncMessage,
  buildHelpMessage,
} from "./format.js";
import { askAgent, clearHistory } from "../agent/index.js";

/**
 * Registers all bot commands on a Telegraf bot instance
 */
export function registerCommands(bot) {
  bot.command("start", (ctx) => ctx.replyWithHTML(buildHelpMessage()));
  bot.command("help", (ctx) => ctx.replyWithHTML(buildHelpMessage()));

  // --- User commands (require registered user) ---

  bot.command("sync", requireUser(), async (ctx) => {
    if (!ctx.user.enablebanking_session_id || !ctx.user.enablebanking_account_id) {
      return ctx.reply("Bank account not connected. Run /connectbank first.");
    }
    try {
      await withTyping(ctx, async () => {
        const user = ctx.user;
        const startTime = Date.now();

        const appId = process.env.ENABLEBANKING_APP_ID;
        const keyPath = process.env.ENABLEBANKING_KEY_PATH;

        // Determine date range
        let dateFrom;
        if (user.last_sync_date) {
          dateFrom = user.last_sync_date;
        } else {
          const ninetyDaysAgo = new Date();
          ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
          dateFrom = ninetyDaysAgo.toISOString().split("T")[0];
        }
        const dateTo = new Date().toISOString().split("T")[0];

        // Fetch transactions from Enable Banking
        const transactions = await getTransactions(
          appId, keyPath, user.enablebanking_account_id, dateFrom, dateTo
        );
        const mappedTransactions = transactions.map(mapTransaction);

        // Import to Actual Budget
        const result = await importTransactions(
          user.actual_server_url, user.actual_password,
          user.actual_budget_id, user.actual_account_id,
          mappedTransactions
        );

        const fetched = transactions.length;
        const imported = result.added?.length || 0;
        const updated = result.updated?.length || 0;
        const skipped = fetched - imported - updated;
        const errors = result.errors?.length || 0;
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Update last_sync_date in DB
        updateUser(ctx.chat.id, { last_sync_date: dateTo });

        await ctx.replyWithHTML(buildSyncMessage({ fetched, imported, updated, skipped, errors, duration }));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("balance", requireUser(), async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const user = ctx.user;
        const accounts = await withActual(user, async (api) => {
          const allAccounts = await api.getAccounts();
          const open = allAccounts.filter((a) => !a.closed);
          const results = [];
          for (const acc of open) {
            const balance = await api.getAccountBalance(acc.id);
            results.push({
              name: acc.name,
              balance,
              onBudget: acc.offbudget === 0 || acc.offbudget === false,
            });
          }
          return results;
        });

        await ctx.replyWithHTML(buildBalanceMessage(accounts));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("transactions", requireUser(), async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const user = ctx.user;
        const args = ctx.message.text.split(/\s+/).slice(1);
        let count = parseInt(args[0], 10);
        if (!count || count < 1) count = 10;
        if (count > 25) count = 25;

        const data = await withActual(user, async (api) => {
          const accounts = await api.getAccounts();
          const open = accounts.filter((a) => !a.closed);

          const endDate = new Date().toISOString().split("T")[0];
          const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

          let allTx = [];
          for (const acc of open) {
            const txs = await api.getTransactions(acc.id, startDate, endDate);
            allTx.push(...txs);
          }

          const payees = await api.getPayees();
          const categories = await api.getCategories();

          return { transactions: allTx, payees, categories };
        });

        const payeeMap = new Map(data.payees.map((p) => [p.id, p.name]));
        const categoryMap = new Map(data.categories.map((c) => [c.id, c.name]));

        const sorted = data.transactions
          .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
          .slice(0, count);

        await ctx.replyWithHTML(buildTransactionsMessage(sorted, payeeMap, categoryMap));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("spending", requireUser(), async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const user = ctx.user;
        const args = ctx.message.text.split(/\s+/).slice(1);
        let month = args[0];
        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
          const now = new Date();
          month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        }

        const result = await withActual(user, async (api) => {
          return await api.getBudgetMonth(month);
        });

        let income = 0;
        let spent = 0;
        const groups = [];

        for (const group of result.categoryGroups || []) {
          const cats = [];
          for (const cat of group.categories || []) {
            const catSpent = cat.spent || 0;
            if (catSpent !== 0) {
              cats.push({ name: cat.name, spent: catSpent });
            }
            income += cat.received || 0;
            spent += catSpent;
          }
          cats.sort((a, b) => Math.abs(b.spent) - Math.abs(a.spent));
          if (cats.length > 0) {
            groups.push({ name: group.name, categories: cats });
          }
        }

        await ctx.replyWithHTML(buildSpendingMessage(month, groups, income, spent));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("clear", requireUser(), (ctx) => {
    clearHistory(ctx.chat.id);
    return ctx.reply("Chat context cleared.");
  });

  // --- Admin commands ---

  bot.command("invite", requireAdmin(), async (ctx) => {
    const code = createInviteCode();
    await ctx.reply(`Invite code: ${code}`);
  });

  bot.command("users", requireAdmin(), async (ctx) => {
    const users = listUsers();
    if (users.length === 0) {
      return ctx.reply("No registered users.");
    }
    let msg = `Registered users (${users.length}):\n\n`;
    for (const u of users) {
      msg += `Chat ID: ${u.chat_id} | Joined: ${u.created_at || "?"} | Last sync: ${u.last_sync_date || "never"}\n`;
    }
    await ctx.reply(msg);
  });

  bot.command("revoke", requireAdmin(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const targetChatId = args[0];
    if (!targetChatId) {
      return ctx.reply("Usage: /revoke <chatId>");
    }
    const deleted = deleteUser(targetChatId);
    if (deleted) {
      await ctx.reply(`User ${targetChatId} has been removed.`);
    } else {
      await ctx.reply(`No user found with chat ID ${targetChatId}.`);
    }
  });

  // --- Default: any plain text message goes to the AI agent ---

  bot.on("text", async (ctx) => {
    // Skip commands (already handled above)
    if (ctx.message.text.startsWith("/")) return;
    if (!ctx.user) {
      return ctx.reply("You're not set up yet. Use /setup to get started.");
    }
    const question = ctx.message.text.trim();
    if (!question) return;
    try {
      await withTyping(ctx, async () => {
        const answer = await askAgent(ctx.user, question);
        await ctx.replyWithHTML(answer);
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });
}
