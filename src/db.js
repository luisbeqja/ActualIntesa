import Database from "better-sqlite3";
import crypto from "crypto";
import { mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const dataDir = join(projectRoot, "data");

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const db = new Database(join(dataDir, "users.db"));

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id TEXT PRIMARY KEY,
    enablebanking_session_id TEXT,
    enablebanking_account_id TEXT,
    actual_server_url TEXT,
    actual_password TEXT,
    actual_budget_id TEXT,
    actual_account_id TEXT,
    last_sync_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),
    used_by TEXT,
    used_at TEXT
  );
`);

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

// --- Prepared statements ---

const stmts = {
  getUser: db.prepare("SELECT * FROM users WHERE chat_id = ?"),
  insertUser: db.prepare(`
    INSERT INTO users (chat_id, enablebanking_session_id, enablebanking_account_id,
      actual_server_url, actual_password, actual_budget_id, actual_account_id, last_sync_date)
    VALUES (@chat_id, @enablebanking_session_id, @enablebanking_account_id,
      @actual_server_url, @actual_password, @actual_budget_id, @actual_account_id, @last_sync_date)
  `),
  deleteUser: db.prepare("DELETE FROM users WHERE chat_id = ?"),
  listUsers: db.prepare("SELECT chat_id, created_at, last_sync_date FROM users"),

  getInviteCode: db.prepare("SELECT * FROM invite_codes WHERE code = ?"),
  insertInviteCode: db.prepare("INSERT INTO invite_codes (code) VALUES (?)"),
  useInviteCode: db.prepare(
    "UPDATE invite_codes SET used_by = ?, used_at = datetime('now') WHERE code = ?"
  ),
};

/**
 * Get a user by Telegram chat ID (decrypts sensitive fields)
 * @param {string} chatId
 * @returns {Object|undefined}
 */
export function getUser(chatId) {
  const row = stmts.getUser.get(String(chatId));
  return decryptFields(row);
}

/**
 * Save (upsert) a user's configuration (encrypts sensitive fields)
 * @param {string} chatId
 * @param {Object} data - User fields to save
 */
export function saveUser(chatId, data) {
  const encrypted = encryptFields(data);
  const existing = stmts.getUser.get(String(chatId));
  if (existing) {
    const fields = Object.keys(encrypted).filter((k) => k !== "chat_id");
    if (fields.length === 0) return;
    const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
    const stmt = db.prepare(`UPDATE users SET ${setClause} WHERE chat_id = @chat_id`);
    stmt.run({ chat_id: String(chatId), ...encrypted });
  } else {
    stmts.insertUser.run({
      chat_id: String(chatId),
      enablebanking_session_id: encrypted.enablebanking_session_id || null,
      enablebanking_account_id: encrypted.enablebanking_account_id || null,
      actual_server_url: encrypted.actual_server_url || null,
      actual_password: encrypted.actual_password || null,
      actual_budget_id: encrypted.actual_budget_id || null,
      actual_account_id: encrypted.actual_account_id || null,
      last_sync_date: encrypted.last_sync_date || null,
    });
  }
}

/**
 * Update specific fields for a user (encrypts sensitive fields)
 * @param {string} chatId
 * @param {Object} data - Fields to update
 */
export function updateUser(chatId, data) {
  const encrypted = encryptFields(data);
  const fields = Object.keys(encrypted);
  if (fields.length === 0) return;
  const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
  const stmt = db.prepare(`UPDATE users SET ${setClause} WHERE chat_id = @chat_id`);
  stmt.run({ chat_id: String(chatId), ...encrypted });
}

/**
 * Delete a user by chat ID
 * @param {string} chatId
 * @returns {boolean} True if a row was deleted
 */
export function deleteUser(chatId) {
  const result = stmts.deleteUser.run(String(chatId));
  return result.changes > 0;
}

/**
 * Create a new invite code
 * @returns {string} The generated invite code
 */
export function createInviteCode() {
  const code = crypto.randomBytes(4).toString("hex");
  stmts.insertInviteCode.run(code);
  return code;
}

/**
 * Validate and consume an invite code
 * @param {string} code
 * @param {string} chatId - The user consuming the code
 * @returns {boolean} True if the code was valid and consumed
 */
export function useInviteCode(code, chatId) {
  const row = stmts.getInviteCode.get(code);
  if (!row || row.used_by) return false;
  stmts.useInviteCode.run(String(chatId), code);
  return true;
}

/**
 * List all registered users (summary info only — no sensitive data)
 * @returns {Object[]}
 */
export function listUsers() {
  return stmts.listUsers.all();
}
