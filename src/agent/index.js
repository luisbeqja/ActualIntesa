import Anthropic from "@anthropic-ai/sdk";
import { withActual } from "../bot/actual-query.js";
import { toolDefinitions, toolExecutors } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";

const MAX_TOOL_ROUNDS = 10;
const MAX_HISTORY = 10;

const client = new Anthropic();

// In-memory chat history per user (chat_id -> [{role, content}])
const chatHistories = new Map();

function getHistory(chatId) {
  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, []);
  }
  return chatHistories.get(chatId);
}

export function clearHistory(chatId) {
  chatHistories.delete(chatId);
}

function addToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  // Keep only the last MAX_HISTORY pairs (user + assistant = 2 entries each)
  while (history.length > MAX_HISTORY * 2) {
    history.shift();
  }
}

/**
 * Ask the AI agent a natural language question about the user's budget.
 * Opens one Actual session, lets Claude call tools inside it, returns the final answer.
 *
 * @param {Object} userConfig - User's Actual Budget connection config
 * @param {string} question - The user's natural language question
 * @returns {Promise<string>} The agent's text response
 */
export async function askAgent(userConfig, question) {
  const chatId = userConfig.chat_id;
  const history = getHistory(chatId);

  // Build messages: history + current question
  const messages = [...history, { role: "user", content: question }];

  // First Claude call — may request tool use
  let response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: buildSystemPrompt(),
    tools: toolDefinitions,
    messages,
  });

  // If no tool use, return immediately
  if (response.stop_reason === "end_stop" || !response.content.some((b) => b.type === "tool_use")) {
    const text = extractText(response);
    addToHistory(chatId, "user", question);
    addToHistory(chatId, "assistant", text);
    return text;
  }

  // Tool-use loop: open one Actual session for all tool calls
  const answer = await withActual(userConfig, async (api) => {
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      // Collect tool_use blocks from this response
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) break;

      // Add assistant message with the full content (text + tool_use blocks)
      messages.push({ role: "assistant", content: response.content });

      // Execute each tool and build result blocks
      const toolResults = [];
      for (const block of toolUseBlocks) {
        console.log(`[agent] Tool call: ${block.name}`, JSON.stringify(block.input));
        const executor = toolExecutors.get(block.name);
        let result;
        if (executor) {
          try {
            result = await executor(api, block.input);
          } catch (err) {
            console.error(`[agent] Tool error (${block.name}):`, err.message);
            result = { error: err.message };
          }
        } else {
          result = { error: `Unknown tool: ${block.name}` };
        }

        console.log(`[agent] Tool result (${block.name}):`, JSON.stringify(result).slice(0, 500));

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });

      // Next Claude call
      response = await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1024,
        system: buildSystemPrompt(),
        tools: toolDefinitions,
        messages,
      });

      // If Claude is done, exit
      if (!response.content.some((b) => b.type === "tool_use")) {
        break;
      }
    }

    return extractText(response);
  });

  addToHistory(chatId, "user", question);
  addToHistory(chatId, "assistant", answer);
  return answer;
}

function extractText(response) {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
