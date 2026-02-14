import { Scenes } from "telegraf";
import { getUser, saveUser, useInviteCode } from "../db.js";
import { validateConnection } from "../actual.js";
import { startAuth, createSession, listBanks } from "../enablebanking.js";

const REDIRECT_URL = "https://enablebanking.com";

function finishMessage(hasBankConnection) {
  let msg = "Setup complete! You can now use:\n";
  if (hasBankConnection) {
    msg += "/sync - Sync bank transactions\n";
  }
  msg +=
    "/balance - Check balances\n" +
    "/transactions - Recent transactions\n" +
    "/spending - Spending breakdown";
  if (!hasBankConnection) {
    msg += "\n\nTo also sync bank transactions, run /connectbank later.";
  }
  return msg;
}

/**
 * Creates the setup wizard scene (Actual Budget config).
 * Bank connection is separate — see createConnectBankWizard().
 */
export function createSetupWizard() {
  const wizard = new Scenes.WizardScene(
    "setup-wizard",

    // Step 0: Check if returning user or ask for invite code
    async (ctx) => {
      const existing = await getUser(ctx.chat.id);
      if (existing) {
        ctx.wizard.state.data = {};
        ctx.wizard.state.isReturning = true;
        await ctx.reply(
          "Welcome back! Let's reconfigure your Actual Budget setup.\n\n" +
          "Enter your Actual Budget server URL (e.g. https://actual.example.com):"
        );
        return ctx.wizard.selectStep(2);
      }

      await ctx.reply("Welcome! To get started, please enter your invite code:");
      return ctx.wizard.next();
    },

    // Step 1: Validate invite code
    async (ctx) => {
      const code = ctx.message?.text?.trim();
      if (!code) {
        await ctx.reply("Please enter a valid invite code:");
        return;
      }

      const used = await useInviteCode(code, ctx.chat.id);
      if (!used) {
        await ctx.reply("Invalid or already used invite code. Try again:");
        return;
      }

      ctx.wizard.state.data = {};
      await ctx.reply(
        "Invite code accepted!\n\n" +
        "Now let's configure Actual Budget.\n" +
        "Enter your Actual Budget server URL (e.g. https://actual.example.com):"
      );
      return ctx.wizard.next();
    },

    // Step 2: Save server URL, ask for password
    async (ctx) => {
      const url = ctx.message?.text?.trim();
      if (!url) {
        await ctx.reply("Please enter a valid URL:");
        return;
      }

      ctx.wizard.state.data.actual_server_url = url;
      await ctx.reply("Enter your Actual Budget password:");
      return ctx.wizard.next();
    },

    // Step 3: Save password, ask for budget sync ID
    async (ctx) => {
      const password = ctx.message?.text?.trim();
      if (!password) {
        await ctx.reply("Please enter your password:");
        return;
      }

      ctx.wizard.state.data.actual_password = password;

      // Delete the password message for security
      try { await ctx.deleteMessage(ctx.message.message_id); } catch (_) {}

      await ctx.reply(
        "Password saved.\n\n" +
        "Enter your Budget Sync ID (Settings -> Advanced in Actual Budget):"
      );
      return ctx.wizard.next();
    },

    // Step 4: Save budget ID, ask for account ID
    async (ctx) => {
      const budgetId = ctx.message?.text?.trim();
      if (!budgetId) {
        await ctx.reply("Please enter a valid Budget Sync ID:");
        return;
      }

      ctx.wizard.state.data.actual_budget_id = budgetId;
      await ctx.reply(
        "Enter the Account ID to sync transactions into.\n" +
        "(Find it in the URL when viewing the account in Actual Budget):"
      );
      return ctx.wizard.next();
    },

    // Step 5: Save account ID, validate Actual connection, save & finish
    async (ctx) => {
      const accountId = ctx.message?.text?.trim();
      if (!accountId) {
        await ctx.reply("Please enter a valid Account ID:");
        return;
      }

      ctx.wizard.state.data.actual_account_id = accountId;

      await ctx.reply("Validating Actual Budget connection...");

      try {
        const { actual_server_url, actual_password, actual_budget_id } = ctx.wizard.state.data;
        await validateConnection(actual_server_url, actual_password, actual_budget_id, accountId);
      } catch (err) {
        await ctx.reply(
          `Connection failed: ${err.message}\n\n` +
          "Let's start over. Enter your Actual Budget server URL:"
        );
        ctx.wizard.state.data = {};
        return ctx.wizard.selectStep(2);
      }

      // Save Actual Budget config
      await saveUser(ctx.chat.id, ctx.wizard.state.data);

      await ctx.reply(
        "Actual Budget connected!\n\n" +
        "Do you want to also connect your bank account for automatic transaction sync?\n\n" +
        "Reply yes or no (you can always run /connectbank later)."
      );
      return ctx.wizard.next();
    },

    // Step 6: Ask about bank connection
    async (ctx) => {
      const answer = ctx.message?.text?.trim().toLowerCase();
      if (!answer) return;

      if (answer === "yes" || answer === "y") {
        // Start bank OAuth
        try {
          const appId = process.env.ENABLEBANKING_APP_ID;
          const keyPath = process.env.ENABLEBANKING_KEY_PATH;

          const banks = await listBanks(appId, keyPath, "IT");
          const intesa = banks.find((b) =>
            b.name.toLowerCase().includes("intesa")
          );

          if (!intesa) {
            await ctx.reply("Could not find Intesa San Paolo in available banks. Contact admin.");
            await ctx.reply(finishMessage(false));
            return ctx.scene.leave();
          }

          const auth = await startAuth(appId, keyPath, intesa.name, intesa.country, REDIRECT_URL);

          await ctx.reply(
            "Open this link to authorize your bank account:\n\n" +
            auth.url +
            "\n\nAfter completing authorization, paste the full redirect URL here."
          );
          return ctx.wizard.next();
        } catch (err) {
          await ctx.reply(`Bank connection error: ${err.message}\nYou can try /connectbank later.`);
          await ctx.reply(finishMessage(false));
          return ctx.scene.leave();
        }
      }

      // No bank connection
      await ctx.reply(finishMessage(false));
      return ctx.scene.leave();
    },

    // Step 7: User pastes redirect URL, create session, pick account
    async (ctx) => {
      const text = ctx.message?.text?.trim();
      if (!text) {
        await ctx.reply("Please paste the redirect URL from the bank authorization:");
        return;
      }

      let code;
      try {
        const url = new URL(text);
        code = url.searchParams.get("code");
      } catch {
        code = text;
      }

      if (!code) {
        await ctx.reply("Could not extract authorization code. Please paste the full redirect URL:");
        return;
      }

      await ctx.reply("Processing bank authorization...");

      try {
        const appId = process.env.ENABLEBANKING_APP_ID;
        const keyPath = process.env.ENABLEBANKING_KEY_PATH;

        const session = await createSession(appId, keyPath, code);
        const bankData = { enablebanking_session_id: session.session_id };

        const accounts = session.accounts || [];
        if (accounts.length === 0) {
          await ctx.reply("No bank accounts found. Contact admin.");
          await ctx.reply(finishMessage(false));
          return ctx.scene.leave();
        }

        if (accounts.length === 1) {
          bankData.enablebanking_account_id = accounts[0].uid;
          await saveUser(ctx.chat.id, bankData);
          await ctx.reply(`Bank account connected: ${accounts[0].account_id?.iban || accounts[0].uid}`);
          await ctx.reply(finishMessage(true));
          return ctx.scene.leave();
        }

        // Multiple accounts — ask user to pick
        ctx.wizard.state.bankAccounts = accounts;
        ctx.wizard.state.bankSessionId = session.session_id;
        let msg = "Select an account by number:\n\n";
        accounts.forEach((acc, i) => {
          const label = acc.account_id?.iban || acc.uid;
          msg += `${i + 1}. ${label}\n`;
        });
        await ctx.reply(msg);
        return ctx.wizard.next();
      } catch (err) {
        await ctx.reply(`Bank session error: ${err.message}\nYou can try /connectbank later.`);
        await ctx.reply(finishMessage(false));
        return ctx.scene.leave();
      }
    },

    // Step 8: Account selection (only reached if multiple bank accounts)
    async (ctx) => {
      const text = ctx.message?.text?.trim();
      const accounts = ctx.wizard.state.bankAccounts || [];
      const idx = parseInt(text, 10) - 1;

      if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
        await ctx.reply(`Please enter a number between 1 and ${accounts.length}:`);
        return;
      }

      await saveUser(ctx.chat.id, {
        enablebanking_session_id: ctx.wizard.state.bankSessionId,
        enablebanking_account_id: accounts[idx].uid,
      });
      const label = accounts[idx].account_id?.iban || accounts[idx].uid;
      await ctx.reply(`Selected: ${label}`);
      await ctx.reply(finishMessage(true));
      return ctx.scene.leave();
    }
  );

  wizard.command("cancel", async (ctx) => {
    await ctx.reply("Setup cancelled.");
    return ctx.scene.leave();
  });

  return wizard;
}

/**
 * Creates the /connectbank wizard scene (bank connection only).
 * Requires user to already have Actual Budget configured.
 */
export function createConnectBankWizard() {
  const wizard = new Scenes.WizardScene(
    "connectbank-wizard",

    // Step 0: Start bank OAuth
    async (ctx) => {
      const user = await getUser(ctx.chat.id);
      if (!user) {
        await ctx.reply("Run /setup first to configure Actual Budget.");
        return ctx.scene.leave();
      }

      try {
        const appId = process.env.ENABLEBANKING_APP_ID;
        const keyPath = process.env.ENABLEBANKING_KEY_PATH;

        const banks = await listBanks(appId, keyPath, "IT");
        const intesa = banks.find((b) =>
          b.name.toLowerCase().includes("intesa")
        );

        if (!intesa) {
          await ctx.reply("Could not find Intesa San Paolo in available banks. Contact admin.");
          return ctx.scene.leave();
        }

        const auth = await startAuth(appId, keyPath, intesa.name, intesa.country, REDIRECT_URL);

        await ctx.reply(
          "Open this link to authorize your bank account:\n\n" +
          auth.url +
          "\n\nAfter completing authorization, paste the full redirect URL here."
        );
        return ctx.wizard.next();
      } catch (err) {
        await ctx.reply(`Bank connection error: ${err.message}\nContact admin.`);
        return ctx.scene.leave();
      }
    },

    // Step 1: User pastes redirect URL
    async (ctx) => {
      const text = ctx.message?.text?.trim();
      if (!text) {
        await ctx.reply("Please paste the redirect URL from the bank authorization:");
        return;
      }

      let code;
      try {
        const url = new URL(text);
        code = url.searchParams.get("code");
      } catch {
        code = text;
      }

      if (!code) {
        await ctx.reply("Could not extract authorization code. Please paste the full redirect URL:");
        return;
      }

      await ctx.reply("Processing bank authorization...");

      try {
        const appId = process.env.ENABLEBANKING_APP_ID;
        const keyPath = process.env.ENABLEBANKING_KEY_PATH;

        const session = await createSession(appId, keyPath, code);
        const bankData = { enablebanking_session_id: session.session_id };

        const accounts = session.accounts || [];
        if (accounts.length === 0) {
          await ctx.reply("No bank accounts found. Contact admin.");
          return ctx.scene.leave();
        }

        if (accounts.length === 1) {
          bankData.enablebanking_account_id = accounts[0].uid;
          await saveUser(ctx.chat.id, bankData);
          await ctx.reply(`Bank account connected: ${accounts[0].account_id?.iban || accounts[0].uid}`);
          await ctx.reply("You can now use /sync to sync transactions.");
          return ctx.scene.leave();
        }

        ctx.wizard.state.bankAccounts = accounts;
        ctx.wizard.state.bankSessionId = session.session_id;
        let msg = "Select an account by number:\n\n";
        accounts.forEach((acc, i) => {
          const label = acc.account_id?.iban || acc.uid;
          msg += `${i + 1}. ${label}\n`;
        });
        await ctx.reply(msg);
        return ctx.wizard.next();
      } catch (err) {
        await ctx.reply(`Bank session error: ${err.message}\nTry /connectbank again.`);
        return ctx.scene.leave();
      }
    },

    // Step 2: Account selection
    async (ctx) => {
      const text = ctx.message?.text?.trim();
      const accounts = ctx.wizard.state.bankAccounts || [];
      const idx = parseInt(text, 10) - 1;

      if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
        await ctx.reply(`Please enter a number between 1 and ${accounts.length}:`);
        return;
      }

      await saveUser(ctx.chat.id, {
        enablebanking_session_id: ctx.wizard.state.bankSessionId,
        enablebanking_account_id: accounts[idx].uid,
      });
      const label = accounts[idx].account_id?.iban || accounts[idx].uid;
      await ctx.reply(`Selected: ${label}`);
      await ctx.reply("You can now use /sync to sync transactions.");
      return ctx.scene.leave();
    }
  );

  wizard.command("cancel", async (ctx) => {
    await ctx.reply("Cancelled.");
    return ctx.scene.leave();
  });

  return wizard;
}
