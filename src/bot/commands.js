import { getTransactions } from "../enablebanking.js";
import { mapTransaction, updateEnvValue } from "../sync.js";
import { importTransactions } from "../actual.js";
import { withActual } from "./actual-query.js";
import { withTyping, friendlyError } from "./middleware.js";
import {
  buildBalanceMessage,
  buildTransactionsMessage,
  buildSpendingMessage,
  buildSyncMessage,
  buildHelpMessage,
} from "./format.js";

/**
 * Registers all bot commands on a Telegraf bot instance
 */
export function registerCommands(bot) {
  bot.command("start", (ctx) => ctx.replyWithHTML(buildHelpMessage()));
  bot.command("help", (ctx) => ctx.replyWithHTML(buildHelpMessage()));

  bot.command("sync", async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const startTime = Date.now();

        const appId = process.env.ENABLEBANKING_APP_ID;
        const keyPath = process.env.ENABLEBANKING_KEY_PATH;
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
          const ninetyDaysAgo = new Date();
          ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
          dateFrom = ninetyDaysAgo.toISOString().split("T")[0];
        }
        const dateTo = new Date().toISOString().split("T")[0];

        // Fetch transactions from Enable Banking
        const transactions = await getTransactions(appId, keyPath, ebAccountId, dateFrom, dateTo);
        const mappedTransactions = transactions.map(mapTransaction);

        // Import to Actual Budget
        const result = await importTransactions(serverUrl, password, budgetId, actualAccountId, mappedTransactions);

        const fetched = transactions.length;
        const imported = result.added?.length || 0;
        const updated = result.updated?.length || 0;
        const skipped = fetched - imported - updated;
        const errors = result.errors?.length || 0;
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Update .env and in-memory env
        updateEnvValue("LAST_SYNC_DATE", dateTo);
        process.env.LAST_SYNC_DATE = dateTo;

        await ctx.replyWithHTML(buildSyncMessage({ fetched, imported, updated, skipped, errors, duration }));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("balance", async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const accounts = await withActual(async (api) => {
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

  bot.command("transactions", async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const args = ctx.message.text.split(/\s+/).slice(1);
        let count = parseInt(args[0], 10);
        if (!count || count < 1) count = 10;
        if (count > 25) count = 25;

        const data = await withActual(async (api) => {
          const accounts = await api.getAccounts();
          const open = accounts.filter((a) => !a.closed);

          // Fetch transactions from the last 90 days across all open accounts
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

        // Build lookup maps
        const payeeMap = new Map(data.payees.map((p) => [p.id, p.name]));
        const categoryMap = new Map(data.categories.map((c) => [c.id, c.name]));

        // Sort by date descending, take N
        const sorted = data.transactions.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0)).slice(0, count);

        await ctx.replyWithHTML(buildTransactionsMessage(sorted, payeeMap, categoryMap));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("spending", async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const args = ctx.message.text.split(/\s+/).slice(1);
        let month = args[0];
        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
          const now = new Date();
          month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        }

        const result = await withActual(async (api) => {
          const budgetMonth = await api.getBudgetMonth(month);
          return budgetMonth;
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
          // Sort categories by absolute spending descending
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
}
