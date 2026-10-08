import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getContestWeekStartMs } from "./week.js";

const PROMPT_MESSAGES_TABLE = "prompt_messages";
const SUBMISSION_COOLDOWNS_TABLE = "submission_cooldowns";
const WEEKLY_SUBMISSIONS_TABLE = "weekly_submissions";
const WEEKLY_VOTES_TABLE = "weekly_votes";
const USER_AVATAR_EMOJIS_TABLE = "user_avatar_emojis";
const SETTINGS_TABLE = "settings";
const CONTEST_START_KEY = "contest_week_start_ms";
const FIRST_WEEK_END_KEY = "first_week_end_ms";
const PENDING_WEEK_END_KEY = "pending_week_end";

export class PhotoContestStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${PROMPT_MESSAGES_TABLE} (
        channel_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${SUBMISSION_COOLDOWNS_TABLE} (
        user_id TEXT PRIMARY KEY,
        submitted_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${WEEKLY_SUBMISSIONS_TABLE} (
        message_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        week_start_ms INTEGER NOT NULL,
        photo_count INTEGER NOT NULL,
        submitted_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_weekly_submissions_week
        ON ${WEEKLY_SUBMISSIONS_TABLE} (week_start_ms);

      CREATE TABLE IF NOT EXISTS ${WEEKLY_VOTES_TABLE} (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        week_start_ms INTEGER NOT NULL,
        voted_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_weekly_votes_week
        ON ${WEEKLY_VOTES_TABLE} (week_start_ms);

      CREATE TABLE IF NOT EXISTS ${USER_AVATAR_EMOJIS_TABLE} (
        user_id TEXT PRIMARY KEY,
        emoji_id TEXT NOT NULL,
        emoji_name TEXT NOT NULL,
        avatar_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contest_batches (
        batch_id TEXT PRIMARY KEY,
        submission_deadline_ms INTEGER NOT NULL,
        voting_start_ms INTEGER NOT NULL,
        voting_end_ms INTEGER NOT NULL,
        thread_id TEXT,
        published_at INTEGER,
        winners_notified_at INTEGER,
        finalized_at INTEGER,
        results_message_id TEXT,
        results_thread_id TEXT
      );

      CREATE TABLE IF NOT EXISTS contest_entries (
        hidden_message_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        description TEXT NOT NULL,
        images_json TEXT NOT NULL,
        photo_count INTEGER NOT NULL,
        submitted_at INTEGER NOT NULL,
        public_message_id TEXT UNIQUE,
        FOREIGN KEY (batch_id) REFERENCES contest_batches(batch_id)
      );
      CREATE INDEX IF NOT EXISTS idx_contest_entries_batch ON contest_entries(batch_id);

      CREATE TABLE IF NOT EXISTS pending_replacements (
        replacement_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        existing_hidden_message_id TEXT NOT NULL,
        candidate_description TEXT NOT NULL,
        candidate_images_json TEXT NOT NULL,
        dm_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        new_hidden_message_id TEXT,
        UNIQUE (batch_id, user_id, status)
      );

      CREATE TABLE IF NOT EXISTS contest_result_entries (
        batch_id TEXT NOT NULL,
        hidden_message_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        vote_count INTEGER NOT NULL,
        published_message_id TEXT,
        PRIMARY KEY (batch_id, hidden_message_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_replacements_unresolved
        ON pending_replacements(batch_id, user_id)
        WHERE status IN ('pending', 'processing');
    `);

    this.addColumnIfMissing("contest_batches", "results_message_id", "TEXT");
    this.addColumnIfMissing("contest_batches", "results_thread_id", "TEXT");
    // Old deployments allowed duplicates. Keep the earliest canonical row before enforcing uniqueness.
    this.db.exec(`
      DELETE FROM contest_entries
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM contest_entries GROUP BY batch_id, user_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contest_entries_batch_user
        ON contest_entries(batch_id, user_id);
    `);

    this.migratePromptMessagesTable();

    if (!this.getSetting(CONTEST_START_KEY)) {
      this.setSetting(CONTEST_START_KEY, String(getContestWeekStartMs()));
    }
  }

  addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  ensureBatch(batch) {
    this.db.prepare(
      `INSERT INTO contest_batches
       (batch_id, submission_deadline_ms, voting_start_ms, voting_end_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(batch_id) DO NOTHING`,
    ).run(batch.batchId, batch.submissionDeadlineMs, batch.votingStartMs, batch.votingEndMs);
    this.db.prepare(
      `UPDATE contest_batches
       SET submission_deadline_ms = ?, voting_start_ms = ?, voting_end_ms = ?
       WHERE batch_id = ? AND published_at IS NULL`,
    ).run(
      batch.submissionDeadlineMs,
      batch.votingStartMs,
      batch.votingEndMs,
      batch.batchId,
    );
    return this.getBatch(batch.batchId);
  }

  getBatchByThreadId(threadId) {
    const row = this.db.prepare(
      `SELECT batch_id AS batchId, submission_deadline_ms AS submissionDeadlineMs,
       voting_start_ms AS votingStartMs, voting_end_ms AS votingEndMs,
       thread_id AS threadId, published_at AS publishedAt,
       winners_notified_at AS winnersNotifiedAt, finalized_at AS finalizedAt,
       results_message_id AS resultsMessageId, results_thread_id AS resultsThreadId
       FROM contest_batches WHERE thread_id = ?`,
    ).get(threadId);
    return row ?? null;
  }

  getBatch(batchId) {
    const row = this.db.prepare(
      `SELECT batch_id AS batchId, submission_deadline_ms AS submissionDeadlineMs,
       voting_start_ms AS votingStartMs, voting_end_ms AS votingEndMs,
       thread_id AS threadId, published_at AS publishedAt,
       winners_notified_at AS winnersNotifiedAt, finalized_at AS finalizedAt,
       results_message_id AS resultsMessageId, results_thread_id AS resultsThreadId
       FROM contest_batches WHERE batch_id = ?`,
    ).get(batchId);
    return row ?? null;
  }

  listDueBatches(now = Date.now()) {
    return this.db.prepare(
      `SELECT batch_id AS batchId, submission_deadline_ms AS submissionDeadlineMs,
       voting_start_ms AS votingStartMs, voting_end_ms AS votingEndMs,
       thread_id AS threadId, published_at AS publishedAt,
       winners_notified_at AS winnersNotifiedAt, finalized_at AS finalizedAt,
       results_message_id AS resultsMessageId, results_thread_id AS resultsThreadId
       FROM contest_batches
       WHERE submission_deadline_ms <= ? OR voting_end_ms <= ?
       ORDER BY submission_deadline_ms`,
    ).all(now, now);
  }

  getLatestPublishedUnfinalizedBatch() {
    return this.db.prepare(
      `SELECT batch_id AS batchId, submission_deadline_ms AS submissionDeadlineMs,
       voting_start_ms AS votingStartMs, voting_end_ms AS votingEndMs,
       thread_id AS threadId, published_at AS publishedAt,
       winners_notified_at AS winnersNotifiedAt, finalized_at AS finalizedAt,
       results_message_id AS resultsMessageId, results_thread_id AS resultsThreadId
       FROM contest_batches
       WHERE published_at IS NOT NULL AND finalized_at IS NULL
       ORDER BY published_at DESC
       LIMIT 1`,
    ).get() ?? null;
  }

  listAllBatches() {
    return this.db.prepare(
      `SELECT batch_id AS batchId, thread_id AS threadId,
       results_message_id AS resultsMessageId, results_thread_id AS resultsThreadId
       FROM contest_batches ORDER BY submission_deadline_ms`,
    ).all();
  }

  listAllContestEntries() {
    return this.db.prepare(
      `SELECT hidden_message_id AS hiddenMessageId, public_message_id AS publicMessageId
       FROM contest_entries`,
    ).all();
  }

  listWeeklySubmissionMessageIds() {
    return this.db.prepare(
      `SELECT message_id AS messageId FROM ${WEEKLY_SUBMISSIONS_TABLE}`,
    ).all().map((row) => row.messageId);
  }

  resetContestData() {
    const removedEntries = this.db.prepare(`DELETE FROM contest_entries`).run().changes;
    this.db.exec(`
      DELETE FROM weekly_votes;
      DELETE FROM weekly_submissions;
      DELETE FROM pending_replacements;
      DELETE FROM contest_result_entries;
      DELETE FROM contest_batches;
      DELETE FROM submission_cooldowns;
      DELETE FROM ${SETTINGS_TABLE}
      WHERE key = '${PENDING_WEEK_END_KEY}' OR key LIKE 'week_end_notified_%';
    `);
    return removedEntries;
  }

  setBatchThreadId(batchId, threadId) {
    this.db.prepare(`UPDATE contest_batches SET thread_id = ? WHERE batch_id = ?`).run(threadId, batchId);
  }

  markBatchPublished(batchId, at = Date.now()) {
    this.db.prepare(
      `UPDATE contest_batches SET published_at = COALESCE(published_at, ?) WHERE batch_id = ?`,
    ).run(at, batchId);
  }

  setBatchVotingWindow(batchId, votingStartMs, votingEndMs) {
    this.db.prepare(
      `UPDATE contest_batches
       SET submission_deadline_ms = ?, voting_start_ms = ?, voting_end_ms = ?
       WHERE batch_id = ? AND published_at IS NULL`,
    ).run(votingStartMs, votingStartMs, votingEndMs, batchId);
    return this.getBatch(batchId);
  }

  markBatchWinnersNotified(batchId, at = Date.now()) {
    this.db.prepare(
      `UPDATE contest_batches SET winners_notified_at = COALESCE(winners_notified_at, ?) WHERE batch_id = ?`,
    ).run(at, batchId);
  }

  markBatchFinalized(batchId, at = Date.now()) {
    this.db.prepare(
      `UPDATE contest_batches SET finalized_at = COALESCE(finalized_at, ?) WHERE batch_id = ?`,
    ).run(at, batchId);
  }

  recordContestEntry(entry) {
    return this.db.prepare(
      `INSERT INTO contest_entries
       (hidden_message_id, batch_id, user_id, description, images_json, photo_count, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(batch_id, user_id) DO NOTHING`,
    ).run(
      entry.hiddenMessageId, entry.batchId, entry.userId, entry.description,
      JSON.stringify(entry.images), entry.photoCount, entry.submittedAt ?? Date.now(),
    ).changes > 0;
  }

  getContestEntryByHiddenMessage(hiddenMessageId) {
    const row = this.db.prepare(
      `SELECT hidden_message_id AS hiddenMessageId, batch_id AS batchId, user_id AS userId,
       description, images_json AS imagesJson, photo_count AS photoCount,
       submitted_at AS submittedAt, public_message_id AS publicMessageId
       FROM contest_entries WHERE hidden_message_id = ?`,
    ).get(hiddenMessageId);
    return row ? { ...row, images: JSON.parse(row.imagesJson) } : null;
  }

  deleteContestEntryByHiddenMessage(hiddenMessageId, now = Date.now()) {
    const entry = this.getContestEntryByHiddenMessage(hiddenMessageId);
    if (!entry) {
      return null;
    }
    this.expirePendingReplacements(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `UPDATE pending_replacements SET status = 'cancelled', resolved_at = ?
         WHERE batch_id = ? AND user_id = ? AND status = 'pending'`,
      ).run(now, entry.batchId, entry.userId);
      this.db.prepare(
        `DELETE FROM contest_entries WHERE hidden_message_id = ?`,
      ).run(hiddenMessageId);
      this.db.exec("COMMIT");
      return entry;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getContestEntry(batchId, userId) {
    const row = this.db.prepare(
      `SELECT hidden_message_id AS hiddenMessageId, batch_id AS batchId, user_id AS userId,
       description, images_json AS imagesJson, photo_count AS photoCount,
       submitted_at AS submittedAt, public_message_id AS publicMessageId
       FROM contest_entries WHERE batch_id = ? AND user_id = ?`,
    ).get(batchId, userId);
    return row ? { ...row, images: JSON.parse(row.imagesJson) } : null;
  }

  getPendingReplacementForUser(batchId, userId, now = Date.now()) {
    this.expirePendingReplacements(now);
    const row = this.db.prepare(
      `SELECT replacement_id AS replacementId, batch_id AS batchId, user_id AS userId,
       existing_hidden_message_id AS existingHiddenMessageId,
       candidate_description AS candidateDescription, candidate_images_json AS candidateImagesJson,
       dm_message_id AS dmMessageId, status, created_at AS createdAt, expires_at AS expiresAt,
       resolved_at AS resolvedAt, new_hidden_message_id AS newHiddenMessageId
       FROM pending_replacements
       WHERE batch_id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`,
    ).get(batchId, userId, now);
    return row ? { ...row, candidateImages: JSON.parse(row.candidateImagesJson) } : null;
  }

  deleteContestEntry(batchId, userId, now = Date.now()) {
    this.expirePendingReplacements(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const entry = this.getContestEntry(batchId, userId);
      if (!entry) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare(
        `UPDATE pending_replacements SET status = 'cancelled', resolved_at = ?
         WHERE batch_id = ? AND user_id = ? AND status = 'pending'`,
      ).run(now, batchId, userId);
      this.db.prepare(
        `DELETE FROM contest_entries WHERE batch_id = ? AND user_id = ?`,
      ).run(batchId, userId);
      this.db.exec("COMMIT");
      return entry;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createPendingReplacement(replacement) {
    this.expirePendingReplacements(replacement.createdAt ?? Date.now());
    this.db.prepare(
      `DELETE FROM pending_replacements
       WHERE batch_id = ? AND user_id = ?`,
    ).run(replacement.batchId, replacement.userId);
    this.db.prepare(
      `INSERT INTO pending_replacements
       (replacement_id, batch_id, user_id, existing_hidden_message_id,
        candidate_description, candidate_images_json, dm_message_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      replacement.replacementId, replacement.batchId, replacement.userId,
      replacement.existingHiddenMessageId, replacement.candidateDescription,
      JSON.stringify(replacement.candidateImages), replacement.dmMessageId ?? null,
      replacement.createdAt, replacement.expiresAt,
    );
    return this.getPendingReplacement(replacement.replacementId);
  }

  getPendingReplacement(replacementId) {
    const row = this.db.prepare(
      `SELECT replacement_id AS replacementId, batch_id AS batchId, user_id AS userId,
       existing_hidden_message_id AS existingHiddenMessageId,
       candidate_description AS candidateDescription, candidate_images_json AS candidateImagesJson,
       dm_message_id AS dmMessageId, status, created_at AS createdAt, expires_at AS expiresAt,
       resolved_at AS resolvedAt, new_hidden_message_id AS newHiddenMessageId
       FROM pending_replacements WHERE replacement_id = ?`,
    ).get(replacementId);
    return row ? { ...row, candidateImages: JSON.parse(row.candidateImagesJson) } : null;
  }

  claimReplacement(replacementId, userId, now = Date.now()) {
    this.expirePendingReplacements(now);
    const result = this.db.prepare(
      `UPDATE pending_replacements SET status = 'processing'
       WHERE replacement_id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`,
    ).run(replacementId, userId, now);
    return result.changes > 0 ? this.getPendingReplacement(replacementId) : null;
  }

  releaseReplacement(replacementId) {
    this.db.prepare(
      `UPDATE pending_replacements SET status = 'pending' WHERE replacement_id = ? AND status = 'processing'`,
    ).run(replacementId);
  }

  cancelReplacement(replacementId, userId, now = Date.now()) {
    const result = this.db.prepare(
      `UPDATE pending_replacements SET status = 'cancelled', resolved_at = ?
       WHERE replacement_id = ? AND user_id = ? AND status = 'pending'`,
    ).run(now, replacementId, userId);
    return result.changes > 0;
  }

  completeReplacement(replacementId, newEntry, now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replacement = this.getPendingReplacement(replacementId);
      if (!replacement || replacement.status !== "processing") {
        throw new Error("Replacement is not claimed");
      }
      const updated = this.db.prepare(
        `UPDATE contest_entries SET hidden_message_id = ?, description = ?, images_json = ?,
         photo_count = 1, submitted_at = ?, public_message_id = NULL
         WHERE batch_id = ? AND user_id = ? AND hidden_message_id = ?`,
      ).run(
        newEntry.hiddenMessageId, newEntry.description, JSON.stringify(newEntry.images),
        newEntry.submittedAt ?? now, replacement.batchId, replacement.userId,
        replacement.existingHiddenMessageId,
      );
      if (updated.changes !== 1) {
        throw new Error("Original contest entry changed before replacement completed");
      }
      this.db.prepare(
        `UPDATE pending_replacements SET status = 'replaced', resolved_at = ?,
         new_hidden_message_id = ? WHERE replacement_id = ?`,
      ).run(now, newEntry.hiddenMessageId, replacementId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  expirePendingReplacements(now = Date.now()) {
    return this.db.prepare(
      `UPDATE pending_replacements SET status = 'expired', resolved_at = ?
       WHERE status = 'pending' AND expires_at <= ?`,
    ).run(now, now).changes;
  }

  setBatchResultsMessage(batchId, messageId) {
    this.db.prepare(
      `UPDATE contest_batches SET results_message_id = COALESCE(results_message_id, ?) WHERE batch_id = ?`,
    ).run(messageId, batchId);
  }

  setBatchResultsThread(batchId, threadId) {
    this.db.prepare(
      `UPDATE contest_batches SET results_thread_id = COALESCE(results_thread_id, ?) WHERE batch_id = ?`,
    ).run(threadId, batchId);
  }

  saveResultRanking(batchId, entries) {
    const insert = this.db.prepare(
      `INSERT INTO contest_result_entries (batch_id, hidden_message_id, rank, vote_count)
       VALUES (?, ?, ?, ?) ON CONFLICT(batch_id, hidden_message_id) DO UPDATE SET
       rank = excluded.rank, vote_count = excluded.vote_count`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) insert.run(batchId, entry.hiddenMessageId, entry.rank, entry.reactionCount);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getResultRanking(batchId) {
    return this.db.prepare(
      `SELECT r.hidden_message_id AS hiddenMessageId, r.rank, r.vote_count AS reactionCount,
       r.published_message_id AS resultMessageId, e.user_id AS userId, e.description,
       e.images_json AS imagesJson, e.submitted_at AS submittedAt, e.public_message_id AS publicMessageId
       FROM contest_result_entries r JOIN contest_entries e
       ON e.hidden_message_id = r.hidden_message_id
       WHERE r.batch_id = ? ORDER BY r.rank`,
    ).all(batchId).map((row) => ({ ...row, images: JSON.parse(row.imagesJson) }));
  }

  markResultEntryPublished(batchId, hiddenMessageId, messageId) {
    this.db.prepare(
      `UPDATE contest_result_entries SET published_message_id = COALESCE(published_message_id, ?)
       WHERE batch_id = ? AND hidden_message_id = ?`,
    ).run(messageId, batchId, hiddenMessageId);
  }

  getBatchEntries(batchId) {
    return this.db.prepare(
      `SELECT hidden_message_id AS hiddenMessageId, batch_id AS batchId, user_id AS userId,
       description, images_json AS imagesJson, photo_count AS photoCount,
       submitted_at AS submittedAt, public_message_id AS publicMessageId
       FROM contest_entries WHERE batch_id = ? ORDER BY submitted_at`,
    ).all(batchId).map((row) => ({ ...row, images: JSON.parse(row.imagesJson) }));
  }

  setEntryPublicMessage(hiddenMessageId, publicMessageId) {
    this.db.prepare(
      `UPDATE contest_entries SET public_message_id = COALESCE(public_message_id, ?)
       WHERE hidden_message_id = ?`,
    ).run(publicMessageId, hiddenMessageId);
  }

  getContestEntryByPublicMessage(messageId) {
    const row = this.db.prepare(
      `SELECT e.batch_id AS batchId, e.user_id AS userId,
       b.voting_start_ms AS votingStartMs, b.voting_end_ms AS votingEndMs
       FROM contest_entries e JOIN contest_batches b ON b.batch_id = e.batch_id
       WHERE e.public_message_id = ?`,
    ).get(messageId);
    return row ?? null;
  }

  getPhasedStats(submissionBatchId, votingBatchId = null) {
    const submissionPhotos = Number(this.db.prepare(
      `SELECT COALESCE(SUM(photo_count), 0) AS total FROM contest_entries WHERE batch_id = ?`,
    ).get(submissionBatchId)?.total ?? 0);
    if (!votingBatchId) return { submissionPhotos, votingEntries: 0, votersCount: 0 };
    const votingEntries = Number(this.db.prepare(
      `SELECT COUNT(*) AS total FROM contest_entries WHERE batch_id = ? AND public_message_id IS NOT NULL`,
    ).get(votingBatchId)?.total ?? 0);
    const votersCount = Number(this.db.prepare(
      `SELECT COUNT(DISTINCT v.user_id) AS total FROM weekly_votes v
       JOIN contest_entries e ON e.public_message_id = v.message_id
       WHERE e.batch_id = ? AND v.user_id != e.user_id`,
    ).get(votingBatchId)?.total ?? 0);
    return { submissionPhotos, votingEntries, votersCount };
  }

  getSetting(key) {
    const row = this.db
      .prepare(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = ?`)
      .get(key);
    return row?.value ?? null;
  }

  setSetting(key, value) {
    this.db
      .prepare(
        `INSERT INTO ${SETTINGS_TABLE} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  clearSetting(key) {
    this.db.prepare(`DELETE FROM ${SETTINGS_TABLE} WHERE key = ?`).run(key);
  }

  getContestWeekStartMs() {
    const stored = this.getSetting(CONTEST_START_KEY);
    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }

    const fallback = getContestWeekStartMs();
    this.setSetting(CONTEST_START_KEY, String(fallback));
    return fallback;
  }

  getFirstWeekEndMs() {
    const stored = this.getSetting(FIRST_WEEK_END_KEY);
    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  setFirstWeekEndMs(value) {
    this.setSetting(FIRST_WEEK_END_KEY, String(value));
  }

  clearFirstWeekEndMs() {
    this.db.prepare(`DELETE FROM ${SETTINGS_TABLE} WHERE key = ?`).run(FIRST_WEEK_END_KEY);
  }

  getPendingWeekEndSession() {
    const raw = this.getSetting(PENDING_WEEK_END_KEY);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      this.clearPendingWeekEndSession();
      return null;
    }
  }

  setPendingWeekEndSession(prepared) {
    this.setSetting(PENDING_WEEK_END_KEY, JSON.stringify(prepared));
  }

  clearPendingWeekEndSession() {
    this.db.prepare(`DELETE FROM ${SETTINGS_TABLE} WHERE key = ?`).run(PENDING_WEEK_END_KEY);
  }

  migratePromptMessagesTable() {
    const columns = this.db
      .prepare(`PRAGMA table_info(${PROMPT_MESSAGES_TABLE})`)
      .all()
      .map((column) => column.name);

    if (!columns.includes("status")) {
      this.db.exec(
        `ALTER TABLE ${PROMPT_MESSAGES_TABLE} ADD COLUMN status TEXT NOT NULL DEFAULT 'missing'`,
      );
    }

    if (!columns.includes("updated_at")) {
      this.db.exec(
        `ALTER TABLE ${PROMPT_MESSAGES_TABLE} ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  getPromptMessageId(channelId) {
    return this.getPromptState(channelId)?.messageId ?? null;
  }

  getPromptState(channelId) {
    const row = this.db
      .prepare(
        `SELECT message_id, status, updated_at FROM ${PROMPT_MESSAGES_TABLE} WHERE channel_id = ?`,
      )
      .get(channelId);

    if (!row) {
      return null;
    }

    return {
      messageId: row.message_id,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  setPromptMessageId(channelId, messageId, status = messageId ? "bottom" : "missing") {
    this.setPromptState(channelId, { messageId, status });
  }

  setPromptState(channelId, { messageId, status = "missing" }) {
    if (!messageId) {
      this.db
        .prepare(`DELETE FROM ${PROMPT_MESSAGES_TABLE} WHERE channel_id = ?`)
        .run(channelId);
      return;
    }

    this.db
      .prepare(
        `INSERT INTO ${PROMPT_MESSAGES_TABLE} (channel_id, message_id, status, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           message_id = excluded.message_id,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(channelId, messageId, status, Date.now());
  }

  clearPromptState(channelId) {
    this.db
      .prepare(`DELETE FROM ${PROMPT_MESSAGES_TABLE} WHERE channel_id = ?`)
      .run(channelId);
  }

  getLastSubmissionAt(userId) {
    const row = this.db
      .prepare(`SELECT submitted_at FROM ${SUBMISSION_COOLDOWNS_TABLE} WHERE user_id = ?`)
      .get(userId);
    return row?.submitted_at ?? null;
  }

  setLastSubmissionAt(userId, submittedAt = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO ${SUBMISSION_COOLDOWNS_TABLE} (user_id, submitted_at) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET submitted_at = excluded.submitted_at`,
      )
      .run(userId, submittedAt);
  }

  clearSubmissionCooldown(userId) {
    const result = this.db
      .prepare(`DELETE FROM ${SUBMISSION_COOLDOWNS_TABLE} WHERE user_id = ?`)
      .run(userId);
    return result.changes > 0;
  }

  recordWeeklySubmission({
    messageId,
    userId,
    weekStartMs,
    photoCount,
    submittedAt = Date.now(),
  }) {
    this.db
      .prepare(
        `INSERT INTO ${WEEKLY_SUBMISSIONS_TABLE}
          (message_id, user_id, week_start_ms, photo_count, submitted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
          user_id = excluded.user_id,
          week_start_ms = excluded.week_start_ms,
          photo_count = excluded.photo_count,
          submitted_at = excluded.submitted_at`,
      )
      .run(messageId, userId, weekStartMs, photoCount, submittedAt);
  }

  isWeeklySubmissionMessage(messageId) {
    const row = this.db
      .prepare(`SELECT 1 FROM ${WEEKLY_SUBMISSIONS_TABLE} WHERE message_id = ?`)
      .get(messageId);
    return Boolean(row);
  }

  getWeeklySubmissionWeekStart(messageId) {
    const row = this.db
      .prepare(`SELECT week_start_ms FROM ${WEEKLY_SUBMISSIONS_TABLE} WHERE message_id = ?`)
      .get(messageId);
    return row?.week_start_ms ?? null;
  }

  recordWeeklyVote({ messageId, userId, weekStartMs, votedAt = Date.now() }) {
    this.db
      .prepare(
        `INSERT INTO ${WEEKLY_VOTES_TABLE}
          (message_id, user_id, week_start_ms, voted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, user_id) DO NOTHING`,
      )
      .run(messageId, userId, weekStartMs, votedAt);
  }

  removeWeeklyVote(messageId, userId) {
    this.db
      .prepare(`DELETE FROM ${WEEKLY_VOTES_TABLE} WHERE message_id = ? AND user_id = ?`)
      .run(messageId, userId);
  }

  getVoteCount(messageId) {
    return Number(
      this.db.prepare(
        `SELECT COUNT(*) AS total
         FROM ${WEEKLY_VOTES_TABLE} v
         LEFT JOIN contest_entries e ON e.public_message_id = v.message_id
         WHERE v.message_id = ?
           AND (e.user_id IS NULL OR v.user_id != e.user_id)`,
      ).get(messageId)?.total ?? 0,
    );
  }

  getUserAvatarEmoji(userId) {
    const row = this.db
      .prepare(
        `SELECT emoji_id, emoji_name, avatar_hash
         FROM ${USER_AVATAR_EMOJIS_TABLE}
         WHERE user_id = ?`,
      )
      .get(userId);

    if (!row) {
      return null;
    }

    return {
      emojiId: row.emoji_id,
      emojiName: row.emoji_name,
      avatarHash: row.avatar_hash,
    };
  }

  setUserAvatarEmoji(userId, { emojiId, emojiName, avatarHash }) {
    this.db
      .prepare(
        `INSERT INTO ${USER_AVATAR_EMOJIS_TABLE}
          (user_id, emoji_id, emoji_name, avatar_hash)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
          emoji_id = excluded.emoji_id,
          emoji_name = excluded.emoji_name,
          avatar_hash = excluded.avatar_hash`,
      )
      .run(userId, emojiId, emojiName, avatarHash);
  }

  getWeeklySubmissions(weekStartMs) {
    return this.db
      .prepare(
        `SELECT message_id AS messageId,
                user_id AS userId,
                week_start_ms AS weekStartMs,
                photo_count AS photoCount,
                submitted_at AS submittedAt
         FROM ${WEEKLY_SUBMISSIONS_TABLE}
         WHERE week_start_ms = ?
         ORDER BY submitted_at ASC`,
      )
      .all(weekStartMs);
  }

  getWeeklyStats(weekStartMs) {
    const photosSubmitted =
      this.db
        .prepare(
          `SELECT COALESCE(SUM(photo_count), 0) AS total
           FROM ${WEEKLY_SUBMISSIONS_TABLE}
           WHERE week_start_ms = ?`,
        )
        .get(weekStartMs)?.total ?? 0;

    const votersCount =
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT user_id) AS total
           FROM ${WEEKLY_VOTES_TABLE}
           WHERE week_start_ms = ?`,
        )
        .get(weekStartMs)?.total ?? 0;

    return {
      photosSubmitted: Number(photosSubmitted) || 0,
      votersCount: Number(votersCount) || 0,
    };
  }
}
