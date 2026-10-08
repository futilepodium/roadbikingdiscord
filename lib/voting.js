import { Events } from "discord.js";
import { getBatchForSubmissionTime, getVotingBatchAt } from "./week.js";
import { SUBMISSION_REPOST_REACTION_EMOJI } from "./submission.js";

function isStarVote(reaction) {
  const emoji = reaction.emoji;
  return emoji.name === SUBMISSION_REPOST_REACTION_EMOJI || emoji.toString() === SUBMISSION_REPOST_REACTION_EMOJI;
}

export function isSelfVote(entry, userId) {
  return Boolean(entry?.userId && userId === entry.userId);
}

export function isVotingWindowOpen(entry, now = Date.now()) {
  return Boolean(entry && now >= entry.votingStartMs && now < entry.votingEndMs);
}

export function registerVotingHandlers(
  client,
  { allowedGuildId, postingChannelId, store, refreshSubmissionPrompt },
) {
  async function handleVoteChange(reaction, user, action) {
    if (user.bot || reaction.message.guildId !== allowedGuildId) {
      return;
    }

    if (reaction.message.channelId !== postingChannelId) {
      return;
    }

    if (!isStarVote(reaction)) {
      return;
    }

    const messageId = reaction.message.id;
    const entry = store.getContestEntryByPublicMessage(messageId);
    if (!entry) {
      return;
    }
    const now = Date.now();
    if (!isVotingWindowOpen(entry, now)) {
      return;
    }
    if (isSelfVote(entry, user.id)) {
      if (action === "add") {
        await reaction.users.remove(user.id).catch((error) => {
          console.error("Failed to remove self-vote reaction:", error);
        });
      }
      return;
    }

    const weekStartMs = entry.votingStartMs;

    if (action === "add") {
      store.recordWeeklyVote({ messageId, userId: user.id, weekStartMs });
    } else {
      store.removeWeeklyVote(messageId, user.id);
    }

    await refreshSubmissionPrompt().catch((error) => {
      console.error("Failed to refresh prompt after vote change:", error);
    });
  }

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (reaction.partial) {
        await reaction.fetch();
      }
      await handleVoteChange(reaction, user, "add");
    } catch (error) {
      console.error("Failed to handle vote add:", error);
    }
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    try {
      if (reaction.partial) {
        await reaction.fetch();
      }
      await handleVoteChange(reaction, user, "remove");
    } catch (error) {
      console.error("Failed to handle vote remove:", error);
    }
  });
}

export function getCurrentWeeklyStats(store, now = Date.now()) {
  const submissionBatch = getBatchForSubmissionTime(now);
  store.ensureBatch(submissionBatch);
  const votingBatch = getVotingBatchAt(now);
  return store.getPhasedStats(submissionBatch.batchId, votingBatch?.batchId);
}
