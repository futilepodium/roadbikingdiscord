/**
 * One-off: delete all messages sent by this bot in DM channels.
 * Usage: node scripts/purge-bot-dms.mjs
 * Requires DISCORD_TOKEN in environment (loads .env if present).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, ChannelType, GatewayIntentBits, Routes } from "discord.js";
import { parseEndNowDmUserIds } from "../lib/week-end.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const TOKEN = process.env.DISCORD_TOKEN?.trim();
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

const DELETE_DELAY_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectBotMessages(channel, botId) {
  const botMessages = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;

    for (const message of batch.values()) {
      if (message.author?.id === botId) botMessages.push(message);
    }

    before = batch.last()?.id;
    if (batch.size < 100) break;
  }

  return botMessages;
}

async function deleteBotMessages(messages) {
  let deleted = 0;
  const failures = [];

  for (const message of messages) {
    try {
      await message.delete();
      deleted += 1;
      await sleep(DELETE_DELAY_MS);
    } catch (error) {
      failures.push({ messageId: message.id, code: error.code, message: error.message });
    }
  }

  return { deleted, failures };
}

async function resolveDmChannelIds(client) {
  const channelIds = new Set();

  try {
    const channels = await client.rest.get(Routes.userChannels());
    for (const channel of channels) {
      if (channel.type === ChannelType.DM) channelIds.add(channel.id);
    }
  } catch (error) {
    console.warn(`Could not list DM channels via API: ${error.message}`);
  }

  for (const userId of parseEndNowDmUserIds()) {
    try {
      const user = await client.users.fetch(userId);
      const dm = await user.createDM();
      channelIds.add(dm.id);
    } catch (error) {
      console.warn(`Could not open DM with user ${userId}: ${error.code ?? ""} ${error.message}`);
    }
  }

  return channelIds;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  const botId = client.user.id;
  console.log(`Logged in as ${client.user.tag}`);

  const channelIds = await resolveDmChannelIds(client);
  console.log(`Found ${channelIds.size} DM channel(s) to inspect`);

  const summary = {
    channelsInspected: 0,
    channelsWithBotMessages: 0,
    messagesDeleted: 0,
    deleteFailures: 0,
    channelErrors: [],
    channels: [],
  };

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isDMBased?.()) {
        summary.channelErrors.push({ channelId, error: "Not a DM channel" });
        continue;
      }

      summary.channelsInspected += 1;
      const recipient = channel.recipient?.tag ?? channel.recipientId ?? "unknown";
      const botMessages = await collectBotMessages(channel, botId);

      if (botMessages.length === 0) {
        summary.channels.push({ channelId, recipient, found: 0, deleted: 0, failures: [] });
        continue;
      }

      summary.channelsWithBotMessages += 1;
      const { deleted, failures } = await deleteBotMessages(botMessages);
      summary.messagesDeleted += deleted;
      summary.deleteFailures += failures.length;
      summary.channels.push({
        channelId,
        recipient,
        found: botMessages.length,
        deleted,
        failures,
      });

      console.log(
        `  ${recipient}: deleted ${deleted}/${botMessages.length} bot message(s)`,
      );
    } catch (error) {
      summary.channelErrors.push({
        channelId,
        error: error.code === 50007 ? "Cannot send messages to this user (blocked/DMs closed)" : error.message,
        code: error.code,
      });
      console.warn(`  Channel ${channelId}: ${error.message}`);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Bot: ${client.user.tag}`);
  console.log(`DM channels inspected: ${summary.channelsInspected}`);
  console.log(`Channels with bot messages: ${summary.channelsWithBotMessages}`);
  console.log(`Bot messages deleted: ${summary.messagesDeleted}`);
  console.log(`Delete failures: ${summary.deleteFailures}`);
  if (summary.channelErrors.length > 0) {
    console.log(`Channel errors: ${summary.channelErrors.length}`);
    for (const err of summary.channelErrors) {
      console.log(`  - ${err.channelId}: ${err.error}`);
    }
  }

  await client.destroy();
  process.exit(summary.deleteFailures > 0 || summary.channelErrors.length > 0 ? 1 : 0);
});

client.login(TOKEN).catch((error) => {
  console.error("Login failed:", error.message);
  process.exit(1);
});
