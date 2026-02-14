import "dotenv/config";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Telegraf } from "telegraf";
import { authGuard } from "./bot/middleware.js";
import { registerCommands } from "./bot/commands.js";

// If ENABLEBANKING_KEY_CONTENT is set (e.g. on Railway), write it to a temp file
// and point ENABLEBANKING_KEY_PATH to it
if (process.env.ENABLEBANKING_KEY_CONTENT && !process.env.ENABLEBANKING_KEY_PATH) {
  const keyPath = join(tmpdir(), "enablebanking-key.pem");
  writeFileSync(keyPath, process.env.ENABLEBANKING_KEY_CONTENT, "utf-8");
  process.env.ENABLEBANKING_KEY_PATH = keyPath;
}

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
