import sharp from "sharp";

const AVATAR_EMOJI_SIZE = 128;
const AVATAR_EMOJI_CACHE_VERSION = "round-v1";

export function getAvatarHashFromUrl(url) {
  const match = String(url ?? "").match(/avatars\/\d+\/([a-f0-9_]+)/i);
  return match?.[1] ?? String(url ?? "");
}

export function buildAvatarEmojiName(userId, avatarHash = "") {
  const version = String(avatarHash).replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return `u${userId}${version ? `_${version}` : ""}`.slice(0, 32);
}

export function buildAvatarEmojiCacheKey(avatarHash) {
  return `${avatarHash}:${AVATAR_EMOJI_CACHE_VERSION}`;
}

export async function makeCircularAvatarBuffer(inputBuffer) {
  const radius = AVATAR_EMOJI_SIZE / 2;
  const circleMask = Buffer.from(
    `<svg width="${AVATAR_EMOJI_SIZE}" height="${AVATAR_EMOJI_SIZE}">
      <circle cx="${radius}" cy="${radius}" r="${radius}" fill="white"/>
    </svg>`,
  );

  return sharp(inputBuffer)
    .resize(AVATAR_EMOJI_SIZE, AVATAR_EMOJI_SIZE, { fit: "cover" })
    .composite([{ input: circleMask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

export async function downloadAvatarBuffer(user) {
  const avatarUrl = user.displayAvatarURL({
    extension: "png",
    size: 128,
    forceStatic: true,
  });
  const response = await fetch(avatarUrl);
  if (!response.ok) {
    throw new Error(`Failed to download avatar: ${response.status}`);
  }

  const squareBuffer = Buffer.from(await response.arrayBuffer());
  const buffer = await makeCircularAvatarBuffer(squareBuffer);

  return {
    buffer,
    avatarHash: buildAvatarEmojiCacheKey(getAvatarHashFromUrl(avatarUrl)),
  };
}

export async function getOrCreateUserAvatarEmoji(client, user, store) {
  await client.application.fetch();

  const { buffer, avatarHash } = await downloadAvatarBuffer(user);
  const cached = store.getUserAvatarEmoji(user.id);

  if (cached?.emojiId && cached.avatarHash === avatarHash) {
    return `<:${cached.emojiName}:${cached.emojiId}>`;
  }

  const name = buildAvatarEmojiName(user.id, avatarHash);
  const applicationEmojis = await client.application.emojis.fetch();
  let emoji = applicationEmojis.find((candidate) => candidate.name === name);

  if (!emoji) {
    try {
      emoji = await client.application.emojis.create({
        name,
        attachment: buffer,
      });
    } catch (error) {
      if (error?.code !== 50035) {
        throw error;
      }

      const refreshed = await client.application.emojis.fetch();
      emoji = refreshed.find((candidate) => candidate.name === name);
      if (!emoji) {
        throw error;
      }
    }
  }

  store.setUserAvatarEmoji(user.id, {
    emojiId: emoji.id,
    emojiName: emoji.name,
    avatarHash,
  });

  return emoji.toString();
}
