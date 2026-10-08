import { Events } from "discord.js";

export function registerSubmissionThreadDeletionHandlers(
  client,
  { store, refreshModReviewPanel, refreshSubmissionPrompt },
) {
  async function handleDeletedSubmissionMessage(messageId, channelId) {
    const batch = store.getBatchByThreadId(channelId);
    if (!batch || batch.publishedAt) {
      return false;
    }

    const entry = store.getContestEntryByHiddenMessage(messageId);
    if (!entry || entry.batchId !== batch.batchId) {
      return false;
    }

    const deleted = store.deleteContestEntryByHiddenMessage(messageId);
    if (!deleted) {
      return false;
    }

    store.clearSubmissionCooldown(deleted.userId);
    console.log(
      `[submission-thread-deletion] Removed contest entry ${messageId} from batch ${batch.batchId}`,
    );

    await refreshSubmissionPrompt?.().catch((error) => {
      console.error("Failed to refresh prompt after mod deletion:", error);
    });
    await refreshModReviewPanel?.().catch((error) => {
      console.error("Failed to refresh mod review panel after deletion:", error);
    });
    return true;
  }

  client.on(Events.MessageDelete, async (message) => {
    try {
      await handleDeletedSubmissionMessage(message.id, message.channelId);
    } catch (error) {
      console.error("[submission-thread-deletion] Failed to handle message delete:", error);
    }
  });

  client.on(Events.MessageBulkDelete, async (messages, channel) => {
    try {
      for (const message of messages.values()) {
        await handleDeletedSubmissionMessage(message.id, channel.id);
      }
    } catch (error) {
      console.error("[submission-thread-deletion] Failed to handle bulk delete:", error);
    }
  });
}
