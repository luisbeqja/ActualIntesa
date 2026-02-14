import "dotenv/config";
import { Telegraf } from "telegraf";
import { authGuard } from "./bot/middleware.js";
import { registerCommands } from "./bot/commands.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

const bot = new Telegraf(token);

// Only allow the owner's chat
bot.use(authGuard(chatId));

// Register all commands
registerCommands(bot);

// Graceful shutdown
const stop = () => {
  bot.stop("SIGINT");
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// Launch
bot.launch().then(() => {
  console.log("ActualIntesa bot started");
});
