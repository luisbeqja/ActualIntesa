import api from "@actual-app/api";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "../..");
const cacheBase = join(projectRoot, "data", "actual-cache");

// Promise-chain mutex to prevent concurrent @actual-app/api access
let mutex = Promise.resolve();

/**
 * Mutex-protected wrapper: init -> downloadBudget -> fn(api) -> shutdown
 * Uses per-user data directory to avoid conflicts.
 * @param {Object} userConfig - { actual_server_url, actual_password, actual_budget_id }
 * @param {Function} fn - Async function receiving the api object
 * @returns {Promise<*>} Result of fn
 */
export function withActual(userConfig, fn) {
  const { actual_server_url, actual_password, actual_budget_id, chat_id } = userConfig;
  const dataDir = join(cacheBase, String(chat_id || "default"));

  const prev = mutex;
  let release;
  mutex = new Promise((resolve) => { release = resolve; });

  return prev.then(async () => {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    try {
      await api.init({
        dataDir,
        serverURL: actual_server_url,
        password: actual_password,
      });
      await api.downloadBudget(actual_budget_id);
      return await fn(api);
    } finally {
      try { await api.shutdown(); } catch (_) {}
      release();
    }
  });
}
