import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAvatarEmojiCacheKey,
  buildAvatarEmojiName,
  getAvatarHashFromUrl,
  makeCircularAvatarBuffer,
} from "./application-emoji.js";

test("getAvatarHashFromUrl extracts avatar hash from cdn url", () => {
  assert.equal(
    getAvatarHashFromUrl("https://cdn.discordapp.com/avatars/123/abc123def.png"),
    "abc123def",
  );
});

test("buildAvatarEmojiName uses user id with u prefix", () => {
  assert.equal(buildAvatarEmojiName("1107839461582184458"), "u1107839461582184458");
});

test("buildAvatarEmojiName includes a stable avatar version", () => {
  assert.equal(
    buildAvatarEmojiName("1107839461582184458", "abc123:round-v1"),
    "u1107839461582184458_abc123ro",
  );
});

test("buildAvatarEmojiCacheKey includes round cache version", () => {
  assert.match(buildAvatarEmojiCacheKey("abc123"), /:round-v1$/);
});

test("makeCircularAvatarBuffer returns a png buffer", async () => {
  const input = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const output = await makeCircularAvatarBuffer(input);
  assert.equal(output.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});
