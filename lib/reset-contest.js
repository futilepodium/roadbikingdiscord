import { withTransientRetry } from "./week-end.js";
import { clearPhotoContestWinnerRole } from "./winner-role.js";

async function deleteMessage(channel, messageId) {
  if (!messageId) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return;
  await withTransientRetry(() => message.delete());
}

async function deleteChannel(client, channelId) {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  await withTransientRetry(() => channel.delete());
}

export async function resetContestEnvironment({
  client,
  store,
  guildId,
  postingChannelId,
  winnersChannelId,
}) {
  if (guildId) {
    await clearPhotoContestWinnerRole({ client, guildId, store }).catch((error) => {
      console.error("Failed to clear photo contest winner role during reset:", error);
    });
  }

  const postingChannel = await client.channels.fetch(postingChannelId).catch(() => null);
  const winnersChannel = await client.channels.fetch(winnersChannelId).catch(() => null);

  const entries = store.listAllContestEntries();
  const batches = store.listAllBatches();
  const weeklySubmissions = store.listWeeklySubmissionMessageIds();

  const votingMessageIds = new Set([
    ...entries.map((entry) => entry.publicMessageId).filter(Boolean),
    ...weeklySubmissions,
  ]);

  if (postingChannel?.isTextBased?.()) {
    for (const messageId of votingMessageIds) {
      await deleteMessage(postingChannel, messageId).catch(() => {});
    }
  }

  for (const batch of batches) {
    await deleteChannel(client, batch.threadId).catch(() => {});
    await deleteChannel(client, batch.resultsThreadId).catch(() => {});
    if (winnersChannel?.isTextBased?.()) {
      await deleteMessage(winnersChannel, batch.resultsMessageId).catch(() => {});
    }
  }

  const removedEntries = store.resetContestData();
  return {
    removedEntries,
    removedVotingMessages: votingMessageIds.size,
    removedBatches: batches.length,
  };
}
