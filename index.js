import { Client, Events, GatewayIntentBits } from "discord.js";
import { getConfig, resolveBotEnv } from "./lib/config.js";
import { registerPhotoPromptHandlers } from "./lib/prompt.js";
import { registerVotingHandlers } from "./lib/voting.js";
import { PhotoContestStore } from "./lib/store.js";
import { setBotGuildNickname, setBotListeningStatus } from "./lib/nickname.js";
import { registerEndNowHandlers } from "./lib/end-now-command.js";
import { registerGuildSlashCommands } from "./lib/guild-commands.js";
import { registerSubmissionChannelGuardHandlers } from "./lib/submission-channel-guard.js";
import { registerSubmitPhotoHandlers } from "./lib/submit-command.js";
import { parseSubmissionCooldownExemptUserIds } from "./lib/submission.js";
import { createContestLifecycle } from "./lib/contest-lifecycle.js";
import { registerQuickEndSubmissionHandlers } from "./lib/quick-end-submission-command.js";
import { registerResetDevHandlers } from "./lib/reset-dev-command.js";
import { registerDevCommandsPanelHandlers } from "./lib/dev-commands-panel.js";
import { registerModReviewPanelHandlers } from "./lib/mod-review-panel.js";
import { registerSubmissionThreadDeletionHandlers } from "./lib/submission-thread-deletion.js";

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CLIENT_ID = process.env.DISCORD_CLIENT_ID?.trim();
const BOT_ENV = resolveBotEnv();
const config = getConfig(BOT_ENV);
const DB_PATH = process.env.PHOTO_CONTEST_DB_PATH?.trim() || "/data/photo-contest.db";

if (!TOKEN) {
  console.error("Missing required env var: DISCORD_TOKEN");
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error("Missing required env var: DISCORD_CLIENT_ID");
  process.exit(1);
}

const store = new PhotoContestStore(DB_PATH);
const submissionCooldownExemptUserIds = parseSubmissionCooldownExemptUserIds();

for (const userId of submissionCooldownExemptUserIds) {
  store.clearSubmissionCooldown(userId);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

const { ensureSubmissionPrompt, refreshSubmissionPrompt } = registerPhotoPromptHandlers(client, {
  promptChannelId: config.postingChannelId,
  legacyPromptChannelId: config.submissionPromptChannelId,
  postingChannelId: config.postingChannelId,
  winnersChannelId: config.winnersChannelId,
  store,
});

registerSubmissionChannelGuardHandlers(client);

const {
  ensureModReviewPanel,
  refreshModReviewPanel,
} = registerModReviewPanelHandlers(client, {
  allowedGuildId: config.guildId,
  channelId: config.modReviewChannelId,
  postingChannelId: config.postingChannelId,
  store,
});

registerSubmissionThreadDeletionHandlers(client, {
  store,
  refreshModReviewPanel,
  refreshSubmissionPrompt,
});

registerSubmitPhotoHandlers(client, {
  allowedGuildId: config.guildId,
  postingChannelId: config.postingChannelId,
  store,
  submissionCooldownExemptUserIds,
  refreshSubmissionPrompt,
  refreshModReviewPanel,
});

registerVotingHandlers(client, {
  allowedGuildId: config.guildId,
  postingChannelId: config.postingChannelId,
  store,
  refreshSubmissionPrompt,
});

const {
  ensureDevCommandsPanel,
  refreshDevCommandsPanel,
  recordDevCommandActivity,
} = registerDevCommandsPanelHandlers(client, {
  allowedGuildId: config.guildId,
  channelId: config.devCommandsChannelId,
  postingChannelId: config.postingChannelId,
  winnersChannelId: config.winnersChannelId,
  store,
  refreshSubmissionPrompt,
});

registerEndNowHandlers(client, {
  allowedGuildId: config.guildId,
  postingChannelId: config.postingChannelId,
  winnersChannelId: config.winnersChannelId,
  store,
  refreshSubmissionPrompt,
  refreshDevCommandsPanel,
  recordDevCommandActivity,
});

registerQuickEndSubmissionHandlers(client, {
  allowedGuildId: config.guildId,
  postingChannelId: config.postingChannelId,
  store,
  refreshSubmissionPrompt,
  recordDevCommandActivity,
});

registerResetDevHandlers(client, {
  allowedGuildId: config.guildId,
  postingChannelId: config.postingChannelId,
  winnersChannelId: config.winnersChannelId,
  store,
  refreshSubmissionPrompt,
  refreshDevCommandsPanel,
  recordDevCommandActivity,
});

const contestLifecycle = createContestLifecycle({
  client,
  store,
  postingChannelId: config.postingChannelId,
  refreshModReviewPanel,
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} (${BOT_ENV})`);

  if (submissionCooldownExemptUserIds.size > 0) {
    console.log(
      `Submission cooldown exempt users: ${[...submissionCooldownExemptUserIds].join(", ")}`,
    );
  }

  try {
    await readyClient.application.fetch();
  } catch (error) {
    console.error("Failed to fetch application for emoji support:", error);
  }

  try {
    await registerGuildSlashCommands({
      token: TOKEN,
      clientId: CLIENT_ID,
      guildId: config.guildId,
    });
    console.log(`Registered guild slash commands in guild ${config.guildId}`);
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }

  try {
    await ensureSubmissionPrompt({ log: true });
  } catch (error) {
    console.error("Failed to ensure submission prompt:", error);
  }

  if (BOT_ENV === "development") {
    try {
      await ensureDevCommandsPanel({ log: true });
    } catch (error) {
      console.error("Failed to ensure dev commands panel:", error);
    }

    try {
      await ensureModReviewPanel({ log: true });
    } catch (error) {
      console.error("Failed to ensure mod review panel:", error);
    }
  }

  const guild = readyClient.guilds.cache.get(config.guildId);
  if (guild) {
    console.log(`Connected to guild: ${guild.name} (${guild.id})`);
  } else {
    console.warn(`Guild ${config.guildId} not found in cache`);
  }

  await setBotGuildNickname(readyClient, config.guildId);
  setBotListeningStatus(readyClient);

  contestLifecycle.run().catch((error) => {
    console.error("Failed initial contest lifecycle check:", error);
  });

  setInterval(() => {
    contestLifecycle.run().catch((error) => {
      console.error("Failed automatic contest lifecycle check:", error);
    });
  }, 60_000);
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

await client.login(TOKEN);
