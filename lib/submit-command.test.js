import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPromptButtonRows,
  buildSubmitPhotoButtonRow,
  buildSubmitPhotoModal,
  buildViewSubmissionsDmPayload,
  CANCEL_BUTTON_PREFIX,
  CHANGE_SUBMISSION_BUTTON_PREFIX,
  DELETE_SUBMISSION_BUTTON_PREFIX,
  LEGACY_CANCEL_BUTTON_PREFIX,
  LEGACY_REPLACE_BUTTON_PREFIX,
  parseReplacementButtonCustomId,
  parseSubmissionManagementButtonCustomId,
  DESCRIPTION_INPUT_ID,
  PHOTOS_INPUT_ID,
  REPLACE_BUTTON_PREFIX,
  SUBMIT_PHOTO_BUTTON_ID,
  VIEW_SUBMISSIONS_BUTTON_ID,
} from "./submit-command.js";
const TEST_GERMAN_USER_ID = "120883716330487809";

test("parseReplacementButtonCustomId accepts env-scoped and legacy button ids", () => {
  const replacementId = "a0bd343d-285f-4cc8-8d5e-a3da4871e104";
  assert.deepEqual(parseReplacementButtonCustomId(`${REPLACE_BUTTON_PREFIX}${replacementId}`), {
    replacing: true,
    replacementId,
  });
  assert.deepEqual(parseReplacementButtonCustomId(`${CANCEL_BUTTON_PREFIX}${replacementId}`), {
    replacing: false,
    replacementId,
  });
  assert.deepEqual(parseReplacementButtonCustomId(`${LEGACY_REPLACE_BUTTON_PREFIX}${replacementId}`), {
    replacing: true,
    replacementId,
  });
  assert.deepEqual(parseReplacementButtonCustomId(`${LEGACY_CANCEL_BUTTON_PREFIX}${replacementId}`), {
    replacing: false,
    replacementId,
  });
  assert.equal(parseReplacementButtonCustomId("not-a-button"), null);
});

test("buildPromptButtonRows includes submit and view buttons", () => {
  const rows = buildPromptButtonRows().map((row) => row.toJSON());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].components.length, 2);
  assert.equal(rows[0].components[0].custom_id, SUBMIT_PHOTO_BUTTON_ID);
  assert.equal(rows[0].components[0].label, "Submit Photo");
  assert.equal(rows[0].components[1].custom_id, VIEW_SUBMISSIONS_BUTTON_ID);
  assert.equal(rows[0].components[1].label, "View your submissions");
});

test("buildSubmitPhotoButtonRow matches the shared prompt row", () => {
  assert.deepEqual(
    buildSubmitPhotoButtonRow().toJSON(),
    buildPromptButtonRows()[0].toJSON(),
  );
});

test("parseSubmissionManagementButtonCustomId parses env-scoped change and delete ids", () => {
  assert.deepEqual(parseSubmissionManagementButtonCustomId(`${CHANGE_SUBMISSION_BUTTON_PREFIX}batch-1`), {
    action: "change",
    batchId: "batch-1",
  });
  assert.deepEqual(parseSubmissionManagementButtonCustomId(`${DELETE_SUBMISSION_BUTTON_PREFIX}batch-1`), {
    action: "delete",
    batchId: "batch-1",
  });
  assert.equal(parseSubmissionManagementButtonCustomId("not-a-button"), null);
});

test("buildViewSubmissionsDmPayload localizes management buttons", () => {
  const previous = process.env.GERMAN_LOCALE_USER_ID;
  process.env.GERMAN_LOCALE_USER_ID = TEST_GERMAN_USER_ID;
  const payload = buildViewSubmissionsDmPayload(
    { images: [{ url: "https://example.com/photo.jpg" }] },
    "batch-1",
    TEST_GERMAN_USER_ID,
  );
  if (previous === undefined) {
    delete process.env.GERMAN_LOCALE_USER_ID;
  } else {
    process.env.GERMAN_LOCALE_USER_ID = previous;
  }
  const actionRow = payload.components.find((component) => component.data?.type === 1);
  const buttons = actionRow.toJSON().components;
  assert.equal(buttons[0].custom_id, `${CHANGE_SUBMISSION_BUTTON_PREFIX}batch-1`);
  assert.equal(buttons[0].label, "Ändern");
  assert.equal(buttons[1].custom_id, `${DELETE_SUBMISSION_BUTTON_PREFIX}batch-1`);
  assert.equal(buttons[1].label, "Löschen");
});

test("submission modal accepts exactly one photo and an optional description", () => {
  const modal = buildSubmitPhotoModal().toJSON();
  assert.equal(modal.components.length, 2);
  const upload = modal.components
    .map((label) => label.component)
    .find((component) => component.custom_id === PHOTOS_INPUT_ID);
  assert.equal(upload.min_values, 1);
  assert.equal(upload.max_values, 1);
  const description = modal.components
    .map((label) => label.component)
    .find((component) => component.custom_id === DESCRIPTION_INPUT_ID);
  assert.equal(description.required, false);
  assert.equal(description.max_length, 1000);
});
