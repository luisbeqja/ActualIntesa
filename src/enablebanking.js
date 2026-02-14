import { readFileSync } from "fs";
import { SignJWT, importPKCS8 } from "jose";
import crypto from "crypto";
import http from "http";

const API_BASE = "https://api.enablebanking.com";

/**
 * Generates a JWT for Enable Banking API authentication
 * @param {string} appId - Enable Banking application ID
 * @param {string} privateKeyPath - Path to the private key .pem file
 * @returns {Promise<string>} JWT token
 */
async function generateJWT(appId, privateKeyPath) {
  const privateKeyPem = readFileSync(privateKeyPath, "utf-8");
  const privateKey = await importPKCS8(privateKeyPem, "RS256");

  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: appId })
    .sign(privateKey);

  return jwt;
}

/**
 * Makes an authenticated API request to Enable Banking
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {string} appId - Application ID
 * @param {string} privateKeyPath - Path to private key
 * @param {Object|null} body - Request body
 * @returns {Promise<Object>} Response data
 */
async function apiRequest(method, path, appId, privateKeyPath, body = null) {
  const token = await generateJWT(appId, privateKeyPath);

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Enable Banking API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Validates credentials by fetching application info
 * @param {string} appId - Application ID
 * @param {string} privateKeyPath - Path to private key
 * @returns {Promise<Object>} Application info
 */
export async function validateCredentials(appId, privateKeyPath) {
  return apiRequest("GET", "/application", appId, privateKeyPath);
}

/**
 * Lists available banks for a country
 * @param {string} appId - Application ID
 * @param {string} privateKeyPath - Path to private key
 * @param {string} country - ISO country code (default: IT)
 * @returns {Promise<Object[]>} List of available banks
 */
export async function listBanks(appId, privateKeyPath, country = "IT") {
  const response = await apiRequest("GET", `/aspsps?country=${country}`, appId, privateKeyPath);
  return response.aspsps || [];
}

/**
 * Starts bank authorization flow
 * @param {string} appId - Application ID
 * @param {string} privateKeyPath - Path to private key
 * @param {string} aspspName - Bank name from listBanks
 * @param {string} aspspCountry - Bank country code
 * @param {string} redirectUrl - Callback URL for authorization
 * @returns {Promise<Object>} Authorization URL and metadata
 */
export async function startAuth(appId, privateKeyPath, aspspName, aspspCountry, redirectUrl) {
  const validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  return apiRequest("POST", "/auth", appId, privateKeyPath, {
    access: { valid_until: validUntil },
    aspsp: { name: aspspName, country: aspspCountry },
    redirect_url: redirectUrl,
    psu_type: "personal",
    state: crypto.randomUUID(),
  });
}

/**
 * Creates a session from the authorization code
 * @param {string} appId - Application ID
 * @param {string} privateKeyPath - Path to private key
 * @param {string} code - Authorization code from callback
 * @returns {Promise<Object>} Session with accounts
 */
export async function createSession(appId, privateKeyPath, code) {
  return apiRequest("POST", "/sessions", appId, privateKeyPath, { code });
}

/**
 * Gets session details including accounts
 * @param {string} appId - Application ID
 * @param {string} privateKeyPath - Path to private key
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object>} Session details
 */
export async function getSession(appId, privateKeyPath, sessionId) {
  return apiRequest("GET", `/sessions/${sessionId}`, appId, privateKeyPath);
}

/**
 * Fetches transactions for an account within a date range
 * @param {string} appId - Application ID
 * @param {string} privateKeyPath - Path to private key
 * @param {string} accountId - Account ID
 * @param {string} dateFrom - Start date (YYYY-MM-DD)
 * @param {string} dateTo - End date (YYYY-MM-DD)
 * @returns {Promise<Object[]>} Array of transactions
 */
export async function getTransactions(appId, privateKeyPath, accountId, dateFrom, dateTo) {
  const allTransactions = [];
  let continuationKey = null;

  do {
    // Build query params
    const params = new URLSearchParams({
      date_from: dateFrom,
      date_to: dateTo,
    });

    if (continuationKey) {
      params.append("continuation_key", continuationKey);
    }

    const path = `/accounts/${accountId}/transactions?${params.toString()}`;

    try {
      const response = await apiRequest("GET", path, appId, privateKeyPath);

      // Accumulate transactions
      if (response.transactions && Array.isArray(response.transactions)) {
        allTransactions.push(...response.transactions);
      }

      // Check for pagination
      continuationKey = response.continuation_key || null;
    } catch (error) {
      // Detect session/auth errors and make them identifiable
      if (error.message.includes("401") || error.message.includes("403") ||
          error.message.toLowerCase().includes("unauthorized") ||
          error.message.toLowerCase().includes("authentication")) {
        throw new Error(`Enable Banking session error: ${error.message}`);
      }
      throw error;
    }
  } while (continuationKey);

  return allTransactions;
}

/**
 * Waits for the OAuth callback on a local HTTP server
 * @param {number} port - Port for the local server (default: 3333)
 * @returns {Promise<string>} Authorization code
 */
export function waitForCallback(port = 3333) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Authorization successful!</h1><p>You can close this window and return to the terminal.</p></body></html>"
          );
          server.close();
          resolve(code);
        } else {
          const error = url.searchParams.get("error") || "Unknown error";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`
          );
          server.close();
          reject(new Error(`Bank authorization failed: ${error}`));
        }
      }
    });

    server.listen(port, () => {});

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(
        new Error("Timeout: Bank authentication not completed within 5 minutes")
      );
    }, 5 * 60 * 1000);
  });
}
