import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPromptContent,
  formatWeekLine,
  formatWeekTimestamp,
  formatWeeklyStatsLines,
  getWeekInfo,
  getBatchForSubmissionTime,
  getVotingBatchAt,
  INITIAL_SUBMISSION_DEADLINE_MS,
  INITIAL_VOTING_START_MS,
  REVIEW_MS,
  WEEK_MS,
} from "./week.js";

test("getWeekInfo supports an extended first week", () => {
  const start = Date.parse("2026-10-02T21:00:00.000Z");
  const firstWeekEnd = Date.parse("2026-10-13T00:00:00.000Z");
  const now = Date.parse("2026-10-05T12:00:00.000Z");
  const info = getWeekInfo(now, start, firstWeekEnd);

  assert.equal(info.weekNumber, 1);
  assert.equal(info.weekEndMs, firstWeekEnd);
  assert.equal(info.remainingMs, firstWeekEnd - now);

  const atEnd = getWeekInfo(firstWeekEnd, start, firstWeekEnd);
  assert.equal(atEnd.weekNumber, 1);
  assert.equal(atEnd.weekEndMs, firstWeekEnd);
});

test("getWeekInfo calculates week number and remaining time", () => {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  const now = start + 2 * 24 * 60 * 60 * 1000;
  const info = getWeekInfo(now, start);

  assert.equal(info.weekNumber, 1);
  assert.equal(info.weekEndMs, start + WEEK_MS);
  assert.equal(info.remainingMs, WEEK_MS - 2 * 24 * 60 * 60 * 1000);
});

test("buildPromptContent includes phased deadlines and mod review line", () => {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  const content = buildPromptContent(start, start + 60_000);

  assert.match(content, /^# Road Biking Photo Content — wk1/);
  assert.match(content, /Submissions close <t:1791676800:F>/);
  assert.match(content, /Voting opens <t:1791763200:F> .* after mod review\./);
  assert.doesNotMatch(content, /Voting begins/);
  assert.doesNotMatch(content, /\/submit-photo/);
});

test("buildPromptContent includes contest reminder without channel overview copy", () => {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  const postingChannelId = "1555675560267620442";
  const winnersChannelId = "1555679698820800562";
  const content = buildPromptContent(start, start + 60_000, {
    postingChannelId,
    winnersChannelId,
  });

  assert.doesNotMatch(content, /Weekly photo contest/);
  assert.match(content, /No AI submissions, please\. And remember to have fun!/);
  assert.doesNotMatch(content, /Use the button or command below to submit a photo/);
});

test("buildPromptContent includes weekly stats at the end", () => {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  const content = buildPromptContent(start, start + 60_000, {
    postingChannelId: "1555675560267620442",
    winnersChannelId: "1555679698820800562",
    weeklyStats: { submissionPhotos: 3, votingEntries: 4, votersCount: 2 },
  });

  assert.match(
    content,
    /3 photos submitted for the next vote\.\n4 entries currently voting; 2 people voted\.$/,
  );
});

test("phased batches include a 24h mod review before voting", () => {
  const beforeFirstClose = Date.parse("2026-10-10T23:59:59Z");
  assert.equal(getBatchForSubmissionTime(beforeFirstClose).submissionDeadlineMs, INITIAL_SUBMISSION_DEADLINE_MS);
  assert.equal(getVotingBatchAt(beforeFirstClose), null);

  const atFirstClose = INITIAL_SUBMISSION_DEADLINE_MS;
  assert.equal(
    getBatchForSubmissionTime(atFirstClose).submissionDeadlineMs,
    atFirstClose + WEEK_MS,
  );
  assert.equal(getBatchForSubmissionTime(atFirstClose).votingStartMs, atFirstClose + REVIEW_MS + WEEK_MS);
  assert.deepEqual(getVotingBatchAt(INITIAL_VOTING_START_MS), {
    batchId: String(INITIAL_SUBMISSION_DEADLINE_MS),
    submissionDeadlineMs: INITIAL_SUBMISSION_DEADLINE_MS,
    votingStartMs: INITIAL_VOTING_START_MS,
    votingEndMs: INITIAL_VOTING_START_MS + WEEK_MS,
  });
});

test("formatWeeklyStatsLines handles singular counts", () => {
  assert.deepEqual(formatWeeklyStatsLines({ photosSubmitted: 1, votersCount: 1 }), [
    "1 photo submitted so far this week.",
    "Voted on by 1 person.",
  ]);
});

test("formatWeeklyStatsLines pluralizes voters from sqlite string counts", () => {
  assert.deepEqual(formatWeeklyStatsLines({ photosSubmitted: "3", votersCount: "2" }), [
    "3 photos submitted so far this week.",
    "Voted on by 2 people.",
  ]);
});

test("formatWeekTimestamp renders Discord relative timestamp", () => {
  const weekEndMs = Date.parse("2026-10-08T00:00:00.000Z");
  assert.equal(formatWeekTimestamp(weekEndMs), "<t:1791417600:R>");
});

test("formatWeekLine includes week label and Discord timestamp", () => {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  assert.equal(
    formatWeekLine(start + 60_000, start),
    "wk1 - ends <t:1791417600:R>",
  );
});
