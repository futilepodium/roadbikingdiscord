import assert from "node:assert/strict";
import test from "node:test";
import { ComponentType, MessageFlags } from "discord.js";
import { PhotoContestStore } from "./store.js";
import {
  buildCandidateImagesFromAttachments,
  buildSubmissionRepostPayload,
  buildWinnerImageFilename,
  extractAttachmentImageUrls,
  extractSubmissionImageUrls,
  formatCooldownRemaining,
  getSubmissionCooldownRemainingMs,
  isImageAttachment,
  isSubmissionCooldownExempt,
  parseSubmissionCooldownExemptUserIds,
  repostSubmission,
  SUBMISSION_COOLDOWN_MS,
  SUBMISSION_REPOST_REACTION_EMOJI,
} from "./submission.js";

test("isImageAttachment accepts image content types and extensions", () => {
  assert.equal(isImageAttachment({ contentType: "image/png", name: "a.bin" }), true);
  assert.equal(isImageAttachment({ contentType: "application/pdf", name: "a.png" }), true);
  assert.equal(isImageAttachment({ url: "https://cdn.discordapp.com/photo.jpg?ex=123" }), true);
  assert.equal(isImageAttachment({ contentType: "application/pdf", name: "a.pdf" }), false);
});

test("submission cooldown enforces one submission per hour", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-test-${Date.now()}.db`);
  const userId = `user-${Date.now()}`;

  store.setLastSubmissionAt(userId, Date.now() - 30 * 60 * 1000);
  assert.equal(getSubmissionCooldownRemainingMs(userId, store) > 0, true);

  store.setLastSubmissionAt(userId, Date.now() - SUBMISSION_COOLDOWN_MS - 1);
  assert.equal(getSubmissionCooldownRemainingMs(userId, store), 0);
});

test("submission cooldown is exempt for configured users", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-test-${Date.now()}.db`);
  const exemptUserIds = parseSubmissionCooldownExemptUserIds("111,222");

  store.setLastSubmissionAt("111", Date.now());
  store.setLastSubmissionAt("333", Date.now() - 30 * 60 * 1000);

  assert.equal(isSubmissionCooldownExempt("111", exemptUserIds), true);
  assert.equal(getSubmissionCooldownRemainingMs("111", store, Date.now(), exemptUserIds), 0);
  assert.equal(getSubmissionCooldownRemainingMs("333", store, Date.now(), exemptUserIds) > 0, true);
});

test("formatCooldownRemaining renders minutes and hours", () => {
  assert.equal(formatCooldownRemaining(90 * 60 * 1000), "1h 30m");
  assert.equal(formatCooldownRemaining(30 * 60 * 1000), "30m");
});

function createMockUser(id = "user-123") {
  return {
    id,
    username: "testuser",
    displayName: "Test User",
    displayAvatarURL: () => "https://cdn.discordapp.com/avatars/123/avatar.png",
    toString: () => `<@${id}>`,
  };
}

test("buildCandidateImagesFromAttachments keeps exactly one uploaded image", () => {
  assert.deepEqual(
    buildCandidateImagesFromAttachments([
      { contentType: "image/jpeg", name: "candidate.jpg", url: "https://cdn.discordapp.com/candidate.jpg" },
    ]),
    [{ url: "https://cdn.discordapp.com/candidate.jpg", name: "candidate.jpg" }],
  );
  assert.throws(
    () => buildCandidateImagesFromAttachments([]),
    /Exactly one candidate image attachment is required/,
  );
});

test("extractAttachmentImageUrls ignores media gallery images", () => {
  const message = {
    attachments: {
      values: () => [
        {
          contentType: "image/jpeg",
          name: "candidate.jpg",
          url: "https://cdn.discordapp.com/attachments/1/3/candidate.jpg",
        },
      ],
    },
    components: [
      {
        type: ComponentType.MediaGallery,
        items: [
          {
            media: { url: "https://cdn.discordapp.com/attachments/1/2/current.png" },
          },
        ],
      },
    ],
  };

  assert.deepEqual(extractAttachmentImageUrls(message), [
    {
      url: "https://cdn.discordapp.com/attachments/1/3/candidate.jpg",
      name: "candidate.jpg",
    },
  ]);
  assert.equal(extractSubmissionImageUrls(message).length, 2);
});

test("extractSubmissionImageUrls reads media gallery images from voting posts", () => {
  const message = {
    attachments: { values: () => [] },
    components: [
      {
        type: ComponentType.MediaGallery,
        items: [
          {
            media: { url: "https://cdn.discordapp.com/attachments/1/2/photo.png" },
          },
        ],
      },
    ],
  };

  assert.deepEqual(extractSubmissionImageUrls(message), [
    {
      url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
      name: "photo.png",
    },
  ]);
});

test("buildWinnerImageFilename keeps a unique winner prefix", () => {
  assert.equal(
    buildWinnerImageFilename("1234567890", "ride.jpg"),
    "winner-1234567890.jpg",
  );
});

test("buildSubmissionRepostPayload uses avatar emoji and top-level galleries", () => {
  const user = createMockUser();
  const files = [{ name: "photo-a.jpg" }, { name: "photo-b.png" }];
  const avatarEmoji = "<:uuser123:999888777>";
  const payload = buildSubmissionRepostPayload(user, "My car", files, avatarEmoji);

  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { users: [user.id] });
  assert.equal(payload.files, files);
  assert.equal(payload.components.length, 4);

  const [descriptionDisplay, galleryA, galleryB, attributionDisplay] =
    payload.components.map((component) => component.toJSON());

  assert.equal(descriptionDisplay.type, ComponentType.TextDisplay);
  assert.equal(descriptionDisplay.content, "My car");

  assert.equal(galleryA.type, ComponentType.MediaGallery);
  assert.equal(galleryA.items[0].media.url, "attachment://photo-a.jpg");
  assert.equal(galleryB.type, ComponentType.MediaGallery);
  assert.equal(galleryB.items[0].media.url, "attachment://photo-b.png");

  assert.equal(attributionDisplay.type, ComponentType.TextDisplay);
  assert.equal(
    attributionDisplay.content,
    `${avatarEmoji} Submitted by <@${user.id}>`,
  );
});

test("buildSubmissionRepostPayload omits description when blank", () => {
  const user = createMockUser();
  const files = [{ name: "photo.jpg" }];
  const payload = buildSubmissionRepostPayload(user, "   ", files, "<:uuser123:999888777>");

  assert.equal(payload.components.length, 2);

  const avatarEmoji = "<:uuser123:999888777>";
  const [gallery, attributionDisplay] = payload.components.map((component) =>
    component.toJSON(),
  );
  assert.equal(gallery.type, ComponentType.MediaGallery);
  assert.equal(gallery.items[0].media.url, "attachment://photo.jpg");
  assert.equal(
    attributionDisplay.content,
    `${avatarEmoji} Submitted by <@${user.id}>`,
  );
});

test("anonymous voting payload contains no submitter identity or mention", () => {
  const user = createMockUser();
  const payload = buildSubmissionRepostPayload(
    user,
    "Mountain road",
    [{ name: "photo.jpg" }],
    "<:privateavatar:123>",
    { anonymous: true },
  );
  const serialized = JSON.stringify(payload.components.map((component) => component.toJSON()));
  assert.equal(serialized.includes(user.id), false);
  assert.equal(serialized.includes("privateavatar"), false);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(serialized.includes("Anonymous entry"), false);
});

test("repostSubmission posts Components v2 payload and reacts with star", async () => {
  const user = createMockUser();
  const attachments = [{ contentType: "image/png", name: "photo.png", url: "https://example.com/photo.png" }];
  const originalFetch = globalThis.fetch;

  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength),
  });

  try {
    const reactions = [];
    const message = {
      react: async (emoji) => {
        reactions.push(emoji);
      },
    };
    const postingChannel = {
      send: async (payload) => {
        assert.equal(payload.flags, MessageFlags.IsComponentsV2);
        assert.equal(payload.components.length, 3);
        assert.equal(payload.files.length, 1);
        return message;
      },
    };

    const client = {
      application: {
        fetch: async () => {},
        emojis: {
          fetch: async () => ({ find: () => undefined }),
          create: async () => ({ id: "999888777", name: "uuser123", toString: () => "<:uuser123:999888777>" }),
          delete: async () => {},
        },
      },
    };
    const store = {
      getUserAvatarEmoji: () => null,
      setUserAvatarEmoji: () => {},
    };

    const result = await repostSubmission({
      client,
      postingChannel,
      user,
      description: "Sunset ride",
      attachments,
      store,
    });

    assert.equal(result, message);
    assert.deepEqual(reactions, [SUBMISSION_REPOST_REACTION_EMOJI]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
