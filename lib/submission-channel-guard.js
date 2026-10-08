import { Events } from "discord.js";
import { getSubmissionPromptChannelIds, getSubmitInstructionChannelLink } from "./config.js";
import { buildSubmitInstructionDmContent } from "./user-locale.js";

export { buildSubmitInstructionDmContent };

export function isSubmissionPromptChannel(channelId, submissionPromptChannelIds = getSubmissionPromptChannelIds()) {
  return submissionPromptChannelIds.has(channelId);
}

export function registerSubmissionChannelGuardHandlers(
  client,
  {
    submissionPromptChannelIds = getSubmissionPromptChannelIds(),
    instructionChannelLink = getSubmitInstructionChannelLink(),
  } = {},
) {
  client.on(Events.MessageCreate, async (message) => {
    if (
      !message.guild ||
      message.author?.bot ||
      !isSubmissionPromptChannel(message.channelId, submissionPromptChannelIds)
    ) {
      return;
    }

    try {
      await message.delete();
    } catch (error) {
      console.error(`Failed to delete message ${message.id} in ${message.channelId}:`, error);
      return;
    }

    try {
      await message.author.send(
        buildSubmitInstructionDmContent(instructionChannelLink, message.author.id),
      );
    } catch (error) {
      console.error(`Failed to DM submit instructions to ${message.author.id}:`, error);
    }
  });
}
