import NordigenClient from "nordigen-node";
import crypto from "crypto";

/**
 * Creates and authenticates a GoCardless (Nordigen) client
 * @param {string} secretId - GoCardless secret ID
 * @param {string} secretKey - GoCardless secret key
 * @returns {Promise<NordigenClient>} Authenticated client
 */
export async function createClient(secretId, secretKey) {
  const client = new NordigenClient({
    secretId,
    secretKey,
  });

  try {
    await client.generateToken();
    return client;
  } catch (error) {
    throw new Error(`Failed to authenticate with GoCardless: ${error.message}`);
  }
}

/**
 * Creates a requisition for Intesa San Paolo
 * @param {NordigenClient} client - Authenticated GoCardless client
 * @returns {Promise<{link: string, requisitionId: string}>} Auth link and requisition ID
 */
export async function createRequisition(client) {
  try {
    // Search for Intesa San Paolo institution
    const institutions = await client.institution.getInstitutions({ country: "IT" });
    const intesa = institutions.find(inst =>
      inst.name.toLowerCase().includes("intesa") &&
      inst.name.toLowerCase().includes("sanpaolo")
    );

    if (!intesa) {
      throw new Error("Intesa San Paolo not found in GoCardless institution list");
    }

    const referenceId = crypto.randomUUID();
    const requisition = await client.initSession({
      redirectUrl: "https://gocardless.com",
      institutionId: intesa.id,
      referenceId,
    });

    return {
      link: requisition.link,
      requisitionId: requisition.id,
    };
  } catch (error) {
    throw new Error(`Failed to create requisition: ${error.message}`);
  }
}

/**
 * Waits for user to complete bank authentication
 * @param {NordigenClient} client - Authenticated GoCardless client
 * @param {string} requisitionId - Requisition ID to poll
 * @returns {Promise<string[]>} Array of account IDs
 */
export async function waitForRequisition(client, requisitionId) {
  const startTime = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes

  while (Date.now() - startTime < timeout) {
    try {
      const requisition = await client.requisition.getRequisitionById(requisitionId);

      if (requisition.status === "LN") {
        // Linked - return accounts
        return requisition.accounts;
      } else if (requisition.status === "RJ") {
        throw new Error("Bank authentication was rejected");
      } else if (requisition.status === "EX") {
        throw new Error("Requisition expired - please restart setup");
      }

      // Status is still CR (created) or another pending state
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    } catch (error) {
      if (error.message.includes("rejected") || error.message.includes("expired")) {
        throw error;
      }
      // Other errors - continue polling
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  throw new Error("Timeout: Bank authentication not completed within 5 minutes. Please restart setup.");
}

/**
 * Gets accounts for a requisition
 * @param {NordigenClient} client - Authenticated GoCardless client
 * @param {string} requisitionId - Requisition ID
 * @returns {Promise<string[]>} Array of account IDs
 */
export async function getAccounts(client, requisitionId) {
  try {
    const requisition = await client.requisition.getRequisitionById(requisitionId);
    return requisition.accounts;
  } catch (error) {
    throw new Error(`Failed to get accounts: ${error.message}`);
  }
}
