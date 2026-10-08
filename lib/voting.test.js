import assert from "node:assert/strict";
import { Events } from "discord.js";
import test from "node:test";
import { SUBMISSION_REPOST_REACTION_EMOJI } from "./submission.js";
import { PhotoContestStore } from "./store.js";
import { isSelfVote, isVotingWindowOpen, registerVotingHandlers } from "./voting.js";

function createStore(name) {
  return new PhotoContestStore(`/tmp/photo-contest-voting-${name}-${Date.now()}-${Math.random()}.db`);
}

function createContestEntry(store, { publicMessageId = "public-1", userId = "submitter-1", now = Date.now() } = {}) {
  const batch = {
    batchId: `batch-${publicMessageId}`,
    submissionDeadlineMs: now - 1000,
    votingStartMs: now - 1000,
    votingEndMs: now + 7 * 24 * 60 * 60 * 1000,
  };
  store.ensureBatch(batch);
  store.recordContestEntry({
    hiddenMessageId: `hidden-${publicMessageId}`,
    batchId: batch.batchId,
    userId,
    description: "A ride",
    images: [{ url: "https://example.test/photo.jpg", name: "photo.jpg" }],
    photoCount: 1,
    submittedAt: 123,
  });
  store.setEntryPublicMessage(`hidden-${publicMessageId}`, publicMessageId);
  return store.getContestEntryByPublicMessage(publicMessageId);
}

function createReactionHarness({ store, guildId = "guild-1", channelId = "posting-1", messageId = "public-1" } = {}) {
  const listeners = new Map();
  const client = {
    on(event, handler) {
      listeners.set(event, handler);
    },
  };
  const refreshCalls = [];
  registerVotingHandlers(client, {
    allowedGuildId: guildId,
    postingChannelId: channelId,
    store,
    refreshSubmissionPrompt: async () => {
      refreshCalls.push(Date.now());
    },
  });

  const removedUserIds = [];
  const reaction = {
    emoji: { name: SUBMISSION_REPOST_REACTION_EMOJI, toString: () => SUBMISSION_REPOST_REACTION_EMOJI },
    message: { id: messageId, guildId, channelId },
    users: {
      remove: async (userId) => {
        removedUserIds.push(userId);
      },
    },
  };

  return {
    handleAdd: listeners.get(Events.MessageReactionAdd),
    handleRemove: listeners.get(Events.MessageReactionRemove),
    reaction,
    refreshCalls,
    removedUserIds,
  };
}

test("isSelfVote identifies submitter reactions", () => {
  assert.equal(isSelfVote({ userId: "user-1" }, "user-1"), true);
  assert.equal(isSelfVote({ userId: "user-1" }, "user-2"), false);
  assert.equal(isSelfVote(null, "user-1"), false);
});

test("bot star reactions are ignored for vote recording", async () => {
  const store = createStore("bot");
  createContestEntry(store);
  const { handleAdd, reaction, refreshCalls } = createReactionHarness({ store });

  await handleAdd(reaction, { id: "bot-1", bot: true });

  assert.equal(store.getVoteCount("public-1"), 0);
  assert.equal(refreshCalls.length, 0);
});

test("self-votes are rejected and the reaction is removed", async () => {
  const store = createStore("self-vote");
  createContestEntry(store, { userId: "submitter-1" });
  const { handleAdd, reaction, refreshCalls, removedUserIds } = createReactionHarness({ store });

  await handleAdd(reaction, { id: "submitter-1", bot: false });

  assert.equal(store.getVoteCount("public-1"), 0);
  assert.deepEqual(removedUserIds, ["submitter-1"]);
  assert.equal(refreshCalls.length, 0);
});

test("valid votes are recorded during the voting window", async () => {
  const store = createStore("valid-vote");
  const now = Date.now();
  const entry = createContestEntry(store, { userId: "submitter-1", now });
  assert.equal(isVotingWindowOpen(entry, now), true);
  const { handleAdd, reaction, refreshCalls } = createReactionHarness({ store });

  await handleAdd(reaction, { id: "voter-1", bot: false });

  assert.equal(store.getVoteCount("public-1"), 1);
  assert.equal(refreshCalls.length, 1);
});

test("vote removal deletes stored votes for other users", async () => {
  const store = createStore("remove-vote");
  createContestEntry(store, { userId: "submitter-1" });
  const { handleAdd, handleRemove, reaction } = createReactionHarness({ store });
  const voter = { id: "voter-1", bot: false };

  await handleAdd(reaction, voter);
  await handleRemove(reaction, voter);

  assert.equal(store.getVoteCount("public-1"), 0);
});
