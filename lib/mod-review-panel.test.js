import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModReviewPanelPayload,
  buildModReviewThreadUrl,
  MOD_REVIEW_PANEL_HEADER,
} from "./mod-review-panel.js";
import { DEV_GUILD_ID } from "./config.js";

test("buildModReviewPanelPayload includes review instructions and link button", () => {
  const payload = buildModReviewPanelPayload({
    guildId: DEV_GUILD_ID,
    threadId: "thread-1",
    submissionCount: 2,
    submissionDeadlineMs: Date.parse("2026-10-11T00:00:00Z"),
    votingStartMs: Date.parse("2026-10-12T00:00:00Z"),
    published: false,
  });

  const content = payload.components[0].data.content;
  assert.match(content, new RegExp(MOD_REVIEW_PANEL_HEADER));
  assert.match(content, /2 submissions waiting for review\./);
  assert.match(content, /Delete any entry in the review thread/);
  const button = payload.components[1].components[0].toJSON();
  assert.equal(button.label, "View submissions channel");
  assert.equal(button.style, 5);
  assert.equal(button.url, buildModReviewThreadUrl(DEV_GUILD_ID, "thread-1"));
});

test("buildModReviewPanelPayload omits link button without a thread", () => {
  const payload = buildModReviewPanelPayload({
    guildId: DEV_GUILD_ID,
    submissionCount: 0,
    published: false,
  });

  assert.equal(payload.components.length, 1);
});
