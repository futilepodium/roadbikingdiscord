import assert from "node:assert/strict";
import test from "node:test";
import { PhotoContestStore } from "./store.js";

test("weekly stats count photos and distinct voters for the current week", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-stats-${Date.now()}.db`);
  const weekStartMs = Date.parse("2026-10-01T00:00:00.000Z");

  store.recordWeeklySubmission({
    messageId: "msg-1",
    userId: "user-1",
    weekStartMs,
    photoCount: 2,
  });
  store.recordWeeklySubmission({
    messageId: "msg-2",
    userId: "user-2",
    weekStartMs,
    photoCount: 1,
  });
  store.recordWeeklyVote({ messageId: "msg-1", userId: "voter-1", weekStartMs });
  store.recordWeeklyVote({ messageId: "msg-2", userId: "voter-1", weekStartMs });
  store.recordWeeklyVote({ messageId: "msg-2", userId: "voter-2", weekStartMs });

  assert.deepEqual(store.getWeeklyStats(weekStartMs), {
    photosSubmitted: 3,
    votersCount: 2,
  });

  store.removeWeeklyVote("msg-2", "voter-2");
  assert.deepEqual(store.getWeeklyStats(weekStartMs), {
    photosSubmitted: 3,
    votersCount: 1,
  });
});

test("contest entry uniqueness and replacement state survive restart", () => {
  const dbPath = `/tmp/photo-contest-replacement-${Date.now()}-${Math.random()}.db`;
  const batch = {
    batchId: "batch-1",
    submissionDeadlineMs: 10,
    votingStartMs: 10,
    votingEndMs: 20,
  };
  let store = new PhotoContestStore(dbPath);
  store.ensureBatch(batch);
  assert.equal(store.recordContestEntry({
    hiddenMessageId: "old", batchId: batch.batchId, userId: "user",
    description: "old", images: [{ url: "old.jpg", name: "old.jpg" }],
    photoCount: 1, submittedAt: 1,
  }), true);
  assert.equal(store.recordContestEntry({
    hiddenMessageId: "duplicate", batchId: batch.batchId, userId: "user",
    description: "duplicate", images: [{ url: "duplicate.jpg" }],
    photoCount: 1, submittedAt: 2,
  }), false);
  store.createPendingReplacement({
    replacementId: "replacement", batchId: batch.batchId, userId: "user",
    existingHiddenMessageId: "old", candidateDescription: "new",
    candidateImages: [{ url: "new.jpg", name: "new.jpg" }],
    createdAt: 100, expiresAt: 1000,
  });
  store = new PhotoContestStore(dbPath);
  assert.equal(store.getPendingReplacement("replacement").status, "pending");
  assert.equal(store.claimReplacement("replacement", "user", 200).status, "processing");
  assert.equal(store.claimReplacement("replacement", "user", 200), null);
  store.completeReplacement("replacement", {
    hiddenMessageId: "new", description: "new",
    images: [{ url: "hosted-new.jpg", name: "new.jpg" }], submittedAt: 200,
  }, 200);
  assert.equal(store.getContestEntry(batch.batchId, "user").hiddenMessageId, "new");
  assert.equal(store.getPendingReplacement("replacement").status, "replaced");
});

test("deleteContestEntry removes the entry and cancels pending replacements", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-delete-${Date.now()}-${Math.random()}.db`);
  const batch = { batchId: "batch", submissionDeadlineMs: 1, votingStartMs: 1, votingEndMs: 2 };
  store.ensureBatch(batch);
  store.recordContestEntry({
    hiddenMessageId: "old", batchId: "batch", userId: "user", description: "old",
    images: [{ url: "old.jpg" }], photoCount: 1,
  });
  store.createPendingReplacement({
    replacementId: "pending", batchId: "batch", userId: "user",
    existingHiddenMessageId: "old", candidateDescription: "new",
    candidateImages: [{ url: "new.jpg" }], createdAt: 1, expiresAt: 100,
  });
  store.setLastSubmissionAt("user", 50);

  const deleted = store.deleteContestEntry("batch", "user", 60);
  assert.equal(deleted.hiddenMessageId, "old");
  assert.equal(store.getContestEntry("batch", "user"), null);
  assert.equal(store.getPendingReplacement("pending").status, "cancelled");
  assert.equal(store.getPendingReplacementForUser("batch", "user", 60), null);
});

test("cancel is idempotent and preserves the original entry", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-cancel-${Date.now()}-${Math.random()}.db`);
  const batch = { batchId: "batch", submissionDeadlineMs: 1, votingStartMs: 1, votingEndMs: 2 };
  store.ensureBatch(batch);
  store.recordContestEntry({
    hiddenMessageId: "old", batchId: "batch", userId: "user", description: "old",
    images: [{ url: "old.jpg" }], photoCount: 1,
  });
  store.createPendingReplacement({
    replacementId: "cancel", batchId: "batch", userId: "user",
    existingHiddenMessageId: "old", candidateDescription: "new",
    candidateImages: [{ url: "new.jpg" }], createdAt: 1, expiresAt: 100,
  });
  assert.equal(store.cancelReplacement("cancel", "user", 2), true);
  assert.equal(store.cancelReplacement("cancel", "user", 3), false);
  assert.equal(store.getContestEntry("batch", "user").hiddenMessageId, "old");
});

test("getVoteCount excludes self-votes and submitter-only voters", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-self-vote-${Date.now()}-${Math.random()}.db`);
  const batch = {
    batchId: "batch-self-vote",
    submissionDeadlineMs: 1,
    votingStartMs: 1,
    votingEndMs: 2,
  };
  store.ensureBatch(batch);
  store.recordContestEntry({
    hiddenMessageId: "hidden-1",
    batchId: batch.batchId,
    userId: "submitter-1",
    description: "",
    images: [{ url: "photo.jpg" }],
    photoCount: 1,
  });
  store.setEntryPublicMessage("hidden-1", "public-1");
  store.recordWeeklyVote({ messageId: "public-1", userId: "submitter-1", weekStartMs: 1 });
  store.recordWeeklyVote({ messageId: "public-1", userId: "voter-1", weekStartMs: 1 });
  store.recordWeeklyVote({ messageId: "public-1", userId: "voter-2", weekStartMs: 1 });

  assert.equal(store.getVoteCount("public-1"), 2);
  assert.deepEqual(store.getPhasedStats("other-batch", batch.batchId), {
    submissionPhotos: 0,
    votingEntries: 1,
    votersCount: 2,
  });
});

test("resetContestData clears contest tables and listing helpers", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-reset-${Date.now()}-${Math.random()}.db`);
  const batch = {
    batchId: "batch-reset",
    submissionDeadlineMs: 1,
    votingStartMs: 1,
    votingEndMs: 2,
    threadId: "thread-1",
    resultsMessageId: "winner-1",
    resultsThreadId: "results-1",
  };
  store.ensureBatch(batch);
  store.recordContestEntry({
    hiddenMessageId: "hidden-1",
    publicMessageId: "public-1",
    batchId: batch.batchId,
    userId: "user-1",
    description: "",
    images: [{ url: "photo.jpg" }],
    photoCount: 1,
  });
  store.recordWeeklySubmission({
    messageId: "legacy-public-1",
    userId: "user-1",
    weekStartMs: 1,
    photoCount: 1,
  });
  store.setPendingWeekEndSession({ batchId: batch.batchId });
  store.setSetting("week_end_notified_batch-reset", "1");

  assert.equal(store.listAllBatches().length, 1);
  assert.equal(store.listAllContestEntries().length, 1);
  assert.equal(store.listWeeklySubmissionMessageIds().length, 1);

  const removedEntries = store.resetContestData();

  assert.equal(removedEntries, 1);
  assert.deepEqual(store.listAllBatches(), []);
  assert.deepEqual(store.listAllContestEntries(), []);
  assert.deepEqual(store.listWeeklySubmissionMessageIds(), []);
  assert.equal(store.getPendingWeekEndSession(), null);
  assert.equal(store.getSetting("week_end_notified_batch-reset"), null);
});

test("prompt state tracks message id, status, and survives restart", () => {
  const dbPath = `/tmp/photo-contest-prompt-${Date.now()}-${Math.random()}.db`;
  const channelId = "1555675560267620442";
  let store = new PhotoContestStore(dbPath);

  assert.equal(store.getPromptState(channelId), null);

  store.setPromptState(channelId, { messageId: "prompt-1", status: "created" });
  const created = store.getPromptState(channelId);
  assert.equal(created.messageId, "prompt-1");
  assert.equal(created.status, "created");
  assert.ok(created.updatedAt > 0);

  store.setPromptState(channelId, { messageId: "prompt-1", status: "bottom" });
  assert.equal(store.getPromptState(channelId).status, "bottom");

  store = new PhotoContestStore(dbPath);
  assert.equal(store.getPromptState(channelId).messageId, "prompt-1");
  assert.equal(store.getPromptState(channelId).status, "bottom");

  store.clearPromptState(channelId);
  assert.equal(store.getPromptState(channelId), null);
  assert.equal(store.getPromptMessageId(channelId), null);
});
