import {
  Events,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { DEV_GUILD_ID, resolveBotEnv } from "./config.js";
import { clearDevEndNowLock } from "./end-now-command.js";
import { resetContestEnvironment } from "./reset-contest.js";
import { canUseEndNow } from "./week-end.js";

export const RESET_DEV_COMMAND_NAME = "reset-dev";

export async function executeResetDev({
  client,
  store,
  allowedGuildId,
  postingChannelId,
  winnersChannelId,
  refreshSubmissionPrompt,
  refreshDevCommandsPanel,
}) {
  clearDevEndNowLock(store);
  store.clearPendingWeekEndSession();

  const result = await resetContestEnvironment({
    client,
    store,
    guildId: allowedGuildId,
    postingChannelId,
    winnersChannelId,
  });

  await refreshSubmissionPrompt?.().catch((error) => {
    console.error("Failed to refresh prompt after reset:", error);
  });
  await refreshDevCommandsPanel?.().catch((error) => {
    console.error("Failed to refresh dev commands panel after reset:", error);
  });

  return result;
}

export function buildResetDevSlashCommand() {
  return new SlashCommandBuilder()
    .setName(RESET_DEV_COMMAND_NAME)
    .setDescription("3. Reset contest submissions, voting, and winner state (dev only)")
    .toJSON();
}

export function registerResetDevHandlers(
  client,
  {
    allowedGuildId = DEV_GUILD_ID,
    postingChannelId,
    winnersChannelId,
    store,
    refreshSubmissionPrompt,
    refreshDevCommandsPanel,
    recordDevCommandActivity,
  },
) {
  if (resolveBotEnv() !== "development") {
    return;
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== RESET_DEV_COMMAND_NAME ||
      interaction.guildId !== allowedGuildId
    ) {
      return;
    }

    if (!canUseEndNow(interaction.user.id)) {
      await interaction.reply({
        content: "You do not have permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    recordDevCommandActivity?.();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await executeResetDev({
        client,
        store,
        allowedGuildId,
        postingChannelId,
        winnersChannelId,
        refreshSubmissionPrompt,
        refreshDevCommandsPanel,
      });
      await interaction.editReply(
        `Development contest reset complete. Removed ${result.removedEntries} submission(s), ${result.removedVotingMessages} voting message(s), and ${result.removedBatches} batch record(s).`,
      );
    } catch (error) {
      console.error("Failed to reset development contest:", error);
      await interaction.editReply("Something went wrong while resetting the development contest.");
    }
  });
}
