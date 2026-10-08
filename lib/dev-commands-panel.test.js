import assert from "node:assert/strict";
import test from "node:test";
import { MessageFlags } from "discord.js";
import {
  buildDevCommandsPanelPayload,
  DEV_COMMANDS_HEADER,
  DEV_END_NOW_BUTTON_ID,
  DEV_IDLE_RESET_MS,
  DEV_QUICK_END_BUTTON_ID,
  DEV_RESET_BUTTON_ID,
  formatDevCommandsPanelPreview,
} from "./dev-commands-panel.js";
import { SUBMIT_PHOTO_BUTTON_ID } from "./submit-command.js";
import { ComponentType } from "discord.js";

test("buildDevCommandsPanelPayload uses components v2 with four command sections", () => {
  const payload = buildDevCommandsPanelPayload();
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.match(formatDevCommandsPanelPreview(), new RegExp(DEV_COMMANDS_HEADER));

  const buttonIds = payload.components
    .filter((component) => component.data?.type === ComponentType.Section)
    .map((section) => section.accessory?.data?.custom_id)
    .filter(Boolean);

  assert.deepEqual(buttonIds, [
    DEV_RESET_BUTTON_ID,
    SUBMIT_PHOTO_BUTTON_ID,
    DEV_QUICK_END_BUTTON_ID,
    DEV_END_NOW_BUTTON_ID,
  ]);
});

test("buildDevCommandsPanelPayload disables end week when locked", () => {
  const payload = buildDevCommandsPanelPayload({ lockedUserId: "1107839461582184458" });
  const endNowSection = payload.components.find(
    (component) =>
      component.data?.type === ComponentType.Section
      && component.accessory?.data?.custom_id === DEV_END_NOW_BUTTON_ID,
  );

  assert.equal(endNowSection.accessory.data.disabled, true);
  assert.match(formatDevCommandsPanelPreview({ lockedUserId: "1107839461582184458" }), /disabled/);
});

test("dev idle reset window is five minutes", () => {
  assert.equal(DEV_IDLE_RESET_MS, 5 * 60 * 1000);
});
