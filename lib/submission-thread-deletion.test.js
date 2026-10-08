import assert from "node:assert/strict";
import { Events } from "discord.js";
import test from "node:test";
import { registerSubmissionThreadDeletionHandlers } from "./submission-thread-deletion.js";
import { PhotoContestStore } from "./store.js";
import { INITIAL_SUBMISSION_DEADLINE_MS, INITIAL_VOTING_START_MS, WEEK_MS } from "./week.js";

function createStore(name) {
  return new PhotoContestStore(`/tmp/photo-contest-delete-${name}-${Date.now()}-${Math.random()}.db`);
}

function createBatchHarness(store) {
  const batch = {
    batchId: String(INITIAL_SUBMISSION_DEADLINE_MS),
    submissionDeadlineMs: INITIAL_SUBMISSION_DEADLINE_MS,
    votingStartMs: INITIAL_VOTING_START_MS,
    votingEndMs: INITIAL_VOTING_START_MS + WEEK_MS,
    threadId: "thread-1",
  };
  store.ensureBatch(batch);
  store.setBatchThreadId(batch.batchId, batch.threadId);
  store.recordContestEntry({
    hiddenMessageId: "hidden-1",
    batchId: batch.batchId,
    userId: "user-1",
    description: "A ride",
    images: [{ url: "https://example.test/photo.jpg", name: "photo.jpg" }],
    photoCount: 1,
    submittedAt: 123,
  });
  return batch;
}

test("deleting a hidden submission message removes it before publish", async () => {
  const store = createStore("delete");
  createBatchHarness(store);
  const listeners = new Map();
  const client = {
    on(event, handler) {
      listeners.set(event, handler);
    },
  };
  let refreshCalls = 0;
  registerSubmissionThreadDeletionHandlers(client, {
    store,
    refreshModReviewPanel: async () => {
      refreshCalls += 1;
    },
    refreshSubmissionPrompt: async () => {},
  });

  await listeners.get(Events.MessageDelete)({ id: "hidden-1", channelId: "thread-1" });

  assert.equal(store.getContestEntryByHiddenMessage("hidden-1"), null);
  assert.equal(store.getBatchEntries(String(INITIAL_SUBMISSION_DEADLINE_MS)).length, 0);
  assert.equal(refreshCalls, 1);
});

test("published batch deletions are ignored", async () => {
  const store = createStore("published");
  const batch = createBatchHarness(store);
  store.markBatchPublished(batch.batchId, Date.now());
  const listeners = new Map();
  const client = {
    on(event, handler) {
      listeners.set(event, handler);
    },
  };
  registerSubmissionThreadDeletionHandlers(client, { store });

  await listeners.get(Events.MessageDelete)({ id: "hidden-1", channelId: "thread-1" });

  assert.notEqual(store.getContestEntryByHiddenMessage("hidden-1"), null);
});
