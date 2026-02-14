import api from "@actual-app/api";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "../..");
const dataDir = join(projectRoot, "actual-data");

// Promise-chain mutex to prevent concurrent @actual-app/api access
let mutex = Promise.resolve();

/**
 * Mutex-protected wrapper: init -> downloadBudget -> fn(api) -> shutdown
 * @param {Function} fn - Async function receiving the api object
 * @returns {Promise<*>} Result of fn
 */
export function withActual(fn) {
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
        serverURL: process.env.ACTUAL_SERVER_URL,
        password: process.env.ACTUAL_PASSWORD,
      });
      await api.downloadBudget(process.env.ACTUAL_BUDGET_ID);
      return await fn(api);
    } finally {
      try { await api.shutdown(); } catch (_) {}
      release();
    }
  });
}
