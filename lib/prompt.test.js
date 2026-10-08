import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPromptPayload,
  findKeepableBottomPrompt,
  isPhotoPromptMessage,
  isPromptAtBottomById,
  messageHasSubmitPhotoButton,
} from "./prompt.js";
import { SUBMIT_PHOTO_BUTTON_ID, VIEW_SUBMISSIONS_BUTTON_ID } from "./submit-command.js";
import { buildPromptContent, PROMPT_TITLE } from "./week.js";

const CONTEST_START = Date.parse("2026-10-01T00:00:00.000Z");
const POSTING_CHANNEL_ID = "1555675560267620442";
const WINNERS_CHANNEL_ID = "1555679698820800562";
const PROMPT = buildPromptContent(CONTEST_START, Date.now(), {
  postingChannelId: POSTING_CHANNEL_ID,
  winnersChannelId: WINNERS_CHANNEL_ID,
});
const LEGACY_EMBED_DESCRIPTION = "wk1 - <t:1759881600:F> (6d 23h remaining)\n`/submit-photo`";

test("isPhotoPromptMessage matches plain content and legacy embed prompts", () => {
  assert.equal(isPhotoPromptMessage({ content: PROMPT }), true);
  assert.equal(
    isPhotoPromptMessage({
      embeds: [{ title: PROMPT_TITLE, description: LEGACY_EMBED_DESCRIPTION }],
    }),
    true,
  );
  assert.equal(isPhotoPromptMessage({ content: "hello" }), false);
  assert.equal(isPhotoPromptMessage({ embeds: [{ title: "Other", description: "nope" }] }), false);
});

test("isPromptAtBottomById matches latest message id", () => {
  assert.equal(isPromptAtBottomById("100", "100"), true);
  assert.equal(isPromptAtBottomById("99", "100"), false);
});

test("buildPromptPayload includes submit and view submission buttons", () => {
  const payload = buildPromptPayload(CONTEST_START, Date.now(), {
    postingChannelId: POSTING_CHANNEL_ID,
    winnersChannelId: WINNERS_CHANNEL_ID,
  });

  assert.equal(payload.components?.length, 1);
  const customIds = payload.components[0].toJSON().components.map((component) => component.custom_id);
  assert.deepEqual(customIds, [SUBMIT_PHOTO_BUTTON_ID, VIEW_SUBMISSIONS_BUTTON_ID]);
});

test("messageHasSubmitPhotoButton detects both prompt buttons", () => {
  assert.equal(
    messageHasSubmitPhotoButton({
      components: [{
        components: [
          { customId: SUBMIT_PHOTO_BUTTON_ID },
          { customId: VIEW_SUBMISSIONS_BUTTON_ID },
        ],
      }],
    }),
    true,
  );
  assert.equal(
    messageHasSubmitPhotoButton({
      components: [{ components: [{ customId: SUBMIT_PHOTO_BUTTON_ID }] }],
    }),
    false,
  );
  assert.equal(messageHasSubmitPhotoButton({ components: [] }), false);
});

test("findKeepableBottomPrompt keeps only bottom prompt", () => {
  const botId = "bot";
  const messages = new Map([
    ["1", { id: "1", author: { id: "user" }, content: "post" }],
    ["2", { id: "2", author: { id: botId }, content: PROMPT }],
  ]);

  assert.equal(findKeepableBottomPrompt(messages, botId)?.id, "2");
  assert.equal(
    findKeepableBottomPrompt(
      new Map([
        ["1", { id: "1", author: { id: botId }, content: PROMPT }],
        ["2", { id: "2", author: { id: "user" }, content: "post" }],
      ]),
      botId,
    ),
    null,
  );
});
