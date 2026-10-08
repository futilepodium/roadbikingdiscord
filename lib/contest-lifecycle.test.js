import assert from "node:assert/strict";
import test from "node:test";
import { ensureContestBatches } from "./contest-lifecycle.js";
import { PhotoContestStore } from "./store.js";
import {
  INITIAL_SUBMISSION_DEADLINE_MS,
  INITIAL_VOTING_START_MS,
  REVIEW_MS,
  WEEK_MS,
} from "./week.js";
import { isVotingWindowOpen } from "./voting.js";
import { getOrCreateBatchThread } from "./submit-command.js";

function createStore(name) {
  return new PhotoContestStore(`/tmp/photo-contest-${name}-${Date.now()}-${Math.random()}.db`);
}

test("catch-up creates every missed weekly batch idempotently", () => {
  const store = createStore("catch-up");
  const now = INITIAL_VOTING_START_MS + 2 * WEEK_MS + 1;
  ensureContestBatches(store, now);
  ensureContestBatches(store, now);

  assert.equal(
    store.getBatch(String(INITIAL_SUBMISSION_DEADLINE_MS)).votingEndMs,
    INITIAL_VOTING_START_MS + WEEK_MS,
  );
  assert.equal(store.listDueBatches(now).length, 3);
  assert.equal(store.getBatch(String(INITIAL_SUBMISSION_DEADLINE_MS + 3 * WEEK_MS)) !== null, true);
});

test("contest entries and transition markers persist across restart", () => {
  const dbPath = `/tmp/photo-contest-persist-${Date.now()}-${Math.random()}.db`;
  const batch = {
    batchId: String(INITIAL_SUBMISSION_DEADLINE_MS),
    submissionDeadlineMs: INITIAL_SUBMISSION_DEADLINE_MS,
    votingStartMs: INITIAL_VOTING_START_MS,
    votingEndMs: INITIAL_VOTING_START_MS + WEEK_MS,
  };
  let store = new PhotoContestStore(dbPath);
  store.ensureBatch(batch);
  store.setBatchThreadId(batch.batchId, "thread-1");
  store.recordContestEntry({
    hiddenMessageId: "hidden-1",
    batchId: batch.batchId,
    userId: "user-1",
    description: "A ride",
    images: [{ url: "https://example.test/photo.jpg", name: "photo.jpg" }],
    photoCount: 1,
    submittedAt: 123,
  });
  store.setEntryPublicMessage("hidden-1", "public-1");
  store.markBatchPublished(batch.batchId, 456);
  store.markBatchPublished(batch.batchId, 999);
  store.markBatchWinnersNotified(batch.batchId, 789);
  store.markBatchWinnersNotified(batch.batchId, 999);
  store = new PhotoContestStore(dbPath);

  assert.equal(store.getBatch(batch.batchId).threadId, "thread-1");
  assert.equal(store.getBatch(batch.batchId).publishedAt, 456);
  assert.equal(store.getBatch(batch.batchId).winnersNotifiedAt, 789);
  assert.equal(store.getBatchEntries(batch.batchId)[0].publicMessageId, "public-1");
});

test("private submission thread is reused for a batch", async () => {
  const batch = {
    batchId: String(INITIAL_SUBMISSION_DEADLINE_MS),
    submissionDeadlineMs: INITIAL_SUBMISSION_DEADLINE_MS,
    votingStartMs: INITIAL_VOTING_START_MS,
    votingEndMs: INITIAL_VOTING_START_MS + WEEK_MS,
  };
  const store = createStore("thread");
  store.ensureBatch(batch);
  let creates = 0;
  const thread = { id: "thread-1", isTextBased: () => true };
  const parent = {
    threads: {
      create: async (options) => {
        creates += 1;
        assert.equal(options.invitable, false);
        return thread;
      },
    },
  };
  const client = {
    channels: {
      fetch: async (id) => (id === "parent" ? parent : thread),
    },
  };

  assert.equal(await getOrCreateBatchThread({
    client, postingChannelId: "parent", store, batch,
  }), thread);
  assert.equal(await getOrCreateBatchThread({
    client, postingChannelId: "parent", store, batch,
  }), thread);
  assert.equal(creates, 1);
});

test("votes are accepted only inside the half-open voting window", () => {
  const entry = {
    votingStartMs: INITIAL_VOTING_START_MS,
    votingEndMs: INITIAL_VOTING_START_MS + WEEK_MS,
  };
  assert.equal(isVotingWindowOpen(entry, entry.votingStartMs - 1), false);
  assert.equal(isVotingWindowOpen(entry, entry.votingStartMs), true);
  assert.equal(isVotingWindowOpen(entry, entry.votingEndMs - 1), true);
  assert.equal(isVotingWindowOpen(entry, entry.votingEndMs), false);
});
