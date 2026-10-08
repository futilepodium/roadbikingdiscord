import {
  Events,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { resolveBotEnv } from "./config.js";
import { publishBatch } from "./contest-lifecycle.js";
import { canUseEndNow } from "./week-end.js";
import { getBatchForSubmissionTime, WEEK_MS } from "./week.js";

export const QUICK_END_SUBMISSION_COMMAND_NAME = "quick-end-submission-period";

export async function executeQuickEndSubmission({
  client,
  store,
  postingChannelId,
  refreshSubmissionPrompt,
}) {
  const scheduled = getBatchForSubmissionTime();
  const current = store.ensureBatch(scheduled);
  if (current.publishedAt) {
    return {
      ok: false,
      message: "The current submission period is already closed.",
    };
  }

  const now = Date.now();
  const batch = store.setBatchVotingWindow(current.batchId, now, now + WEEK_MS);
  await publishBatch({ client, store, postingChannelId, batch, now });
  await refreshSubmissionPrompt?.();

  return {
    ok: true,
    message: `Submission period closed. Voting is open until <t:${Math.floor(batch.votingEndMs / 1000)}:F>.`,
  };
}

export function buildQuickEndSubmissionSlashCommand() {
  return new SlashCommandBuilder()
    .setName(QUICK_END_SUBMISSION_COMMAND_NAME)
    .setDescription("1. Close submissions now and begin the voting period")
    .toJSON();
}

export function registerQuickEndSubmissionHandlers(
  client,
  { allowedGuildId, postingChannelId, store, refreshSubmissionPrompt, recordDevCommandActivity },
) {
  if (resolveBotEnv() !== "development") {
    return;
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (
      !interaction.isChatInputCommand() ||
      interaction.commandName !== QUICK_END_SUBMISSION_COMMAND_NAME ||
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
      const result = await executeQuickEndSubmission({
        client,
        store,
        postingChannelId,
        refreshSubmissionPrompt,
      });
      await interaction.editReply(result.message);
    } catch (error) {
      console.error("Failed to quick-end submission period:", error);
      await interaction.editReply("Something went wrong while ending the submission period.");
    }
  });
}
