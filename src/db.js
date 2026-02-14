import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

// --- Schema init (call once at startup) ---

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT PRIMARY KEY,
      enablebanking_session_id TEXT,
      enablebanking_account_id TEXT,
      actual_server_url TEXT,
      actual_password TEXT,
      actual_budget_id TEXT,
      actual_account_id TEXT,
      last_sync_date TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      used_by TEXT,
      used_at TIMESTAMPTZ
    );
  `);
}

// --- Encryption (AES-256-GCM) ---
// Key derived from TELEGRAM_BOT_TOKEN — protects data at rest in case
// the .db file is leaked without the .env file.

const SENSITIVE_FIELDS = ["actual_password", "enablebanking_session_id"];
const SALT = "actualintesa-v1";

let encryptionKey = null;

function getKey() {
  if (encryptionKey) return encryptionKey;
  const secret = process.env.TELEGRAM_BOT_TOKEN;
  if (!secret) throw new Error("TELEGRAM_BOT_TOKEN required for database encryption");
  encryptionKey = crypto.pbkdf2Sync(secret, SALT, 100_000, 32, "sha256");
  return encryptionKey;
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(stored) {
  if (!stored) return null;
  const parts = stored.split(":");
  if (parts.length !== 3) return stored; // not encrypted (legacy plaintext)
  const [ivHex, tagHex, dataHex] = parts;
  try {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const data = Buffer.from(dataHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(data) + decipher.final("utf8");
  } catch {
    return stored; // decryption failed — return as-is (legacy plaintext)
  }
}

function encryptFields(data) {
  const out = { ...data };
  for (const field of SENSITIVE_FIELDS) {
    if (field in out && out[field]) {
      out[field] = encrypt(out[field]);
    }
  }
  return out;
}

function decryptFields(row) {
  if (!row) return row;
  const out = { ...row };
  for (const field of SENSITIVE_FIELDS) {
    if (out[field]) {
      out[field] = decrypt(out[field]);
    }
  }
  return out;
}

// --- Database functions (all async) ---

/**
 * Get a user by Telegram chat ID (decrypts sensitive fields)
 * @param {string} chatId
 * @returns {Promise<Object|undefined>}
 */
export async function getUser(chatId) {
  const { rows } = await pool.query("SELECT * FROM users WHERE chat_id = $1", [String(chatId)]);
  return decryptFields(rows[0]);
}

/**
 * Save (upsert) a user's configuration (encrypts sensitive fields)
 * @param {string} chatId
 * @param {Object} data - User fields to save
 */
export async function saveUser(chatId, data) {
  const encrypted = encryptFields(data);
  const { rows } = await pool.query("SELECT 1 FROM users WHERE chat_id = $1", [String(chatId)]);
  if (rows.length > 0) {
    const fields = Object.keys(encrypted).filter((k) => k !== "chat_id");
    if (fields.length === 0) return;
    const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [String(chatId), ...fields.map((f) => encrypted[f] ?? null)];
    await pool.query(`UPDATE users SET ${setClause} WHERE chat_id = $1`, values);
  } else {
    const columns = [
      "chat_id", "enablebanking_session_id", "enablebanking_account_id",
      "actual_server_url", "actual_password", "actual_budget_id",
      "actual_account_id", "last_sync_date",
    ];
    const values = [
      String(chatId),
      encrypted.enablebanking_session_id || null,
      encrypted.enablebanking_account_id || null,
      encrypted.actual_server_url || null,
      encrypted.actual_password || null,
      encrypted.actual_budget_id || null,
      encrypted.actual_account_id || null,
      encrypted.last_sync_date || null,
    ];
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    await pool.query(
      `INSERT INTO users (${columns.join(", ")}) VALUES (${placeholders})`,
      values
    );
  }
}

/**
 * Update specific fields for a user (encrypts sensitive fields)
 * @param {string} chatId
 * @param {Object} data - Fields to update
 */
export async function updateUser(chatId, data) {
  const encrypted = encryptFields(data);
  const fields = Object.keys(encrypted);
  if (fields.length === 0) return;
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  const values = [String(chatId), ...fields.map((f) => encrypted[f] ?? null)];
  await pool.query(`UPDATE users SET ${setClause} WHERE chat_id = $1`, values);
}

/**
 * Delete a user by chat ID
 * @param {string} chatId
 * @returns {Promise<boolean>} True if a row was deleted
 */
export async function deleteUser(chatId) {
  const result = await pool.query("DELETE FROM users WHERE chat_id = $1", [String(chatId)]);
  return result.rowCount > 0;
}

/**
 * Create a new invite code
 * @returns {Promise<string>} The generated invite code
 */
export async function createInviteCode() {
  const code = crypto.randomBytes(4).toString("hex");
  await pool.query("INSERT INTO invite_codes (code) VALUES ($1)", [code]);
  return code;
}

/**
 * Validate and consume an invite code
 * @param {string} code
 * @param {string} chatId - The user consuming the code
 * @returns {Promise<boolean>} True if the code was valid and consumed
 */
export async function useInviteCode(code, chatId) {
  const { rows } = await pool.query("SELECT * FROM invite_codes WHERE code = $1", [code]);
  if (rows.length === 0 || rows[0].used_by) return false;
  await pool.query(
    "UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = $2",
    [String(chatId), code]
  );
  return true;
}

/**
 * List all registered users (summary info only — no sensitive data)
 * @returns {Promise<Object[]>}
 */
export async function listUsers() {
  const { rows } = await pool.query("SELECT chat_id, created_at, last_sync_date FROM users");
  return rows;
}
