require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  AuditLogEvent,
  PermissionsBitField,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

const protectedUserIds = new Set(
  (process.env.PROTECTED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

const disconnectMessageChannelId = (
  process.env.DISCONNECT_MESSAGE_CHANNEL_ID || ""
).trim();

const idiotCornerChannelId = (
  process.env.IDIOT_CORNER_CHANNEL_ID || ""
).trim();

const randomReplies = [
  "Is ryan banging on about his house again?",
  "Does danny need some imodium?",
  "Has luke killed another old man yet?",
  "Whens Jack getting his hair transplant?",
  "Someone getting disconnected again?",
  "I am watching the voice channels 👀",
  "Danny stood in dog shit again?",
  "Is big jim still playing league?",
  "Wes fell off his ped?",
  "Dylan having another maccies?",
  "IM BORED!!",
  "Thats not very merry christmas of you",
  "Is he awping mid?",
  "Clear comms",
  "Ugga Dugga",
  "Baldy Baldy",
  "DDDDYYYLLLLLOOOONNNN",
  "Dont do it baby",
  "Has dyl been using the makeup bin again?",
  "No Baby",
];

// Stores the latest count for Discord audit entries.
const disconnectAuditCounts = new Map();
const moveAuditCounts = new Map();

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

if (protectedUserIds.size === 0) {
  console.error("Missing PROTECTED_USER_IDS in .env");
  process.exit(1);
}

if (!disconnectMessageChannelId) {
  console.error("Missing DISCONNECT_MESSAGE_CHANNEL_ID in .env");
  process.exit(1);
}

if (!idiotCornerChannelId) {
  console.error("Missing IDIOT_CORNER_CHANNEL_ID in .env");
  process.exit(1);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getAuditKey(guildId, entryId) {
  return `${guildId}:${entryId}`;
}

function getAuditCount(entry) {
  const count = Number(entry.extra?.count ?? 1);

  return Number.isFinite(count) ? count : 1;
}

/**
 * Discord.js normally exposes the channel in entry.extra.channel
 * for MEMBER_MOVE audit entries.
 */
function getMoveDestinationChannelId(entry) {
  return (
    entry.extra?.channel?.id ??
    entry.extra?.channelId ??
    null
  );
}

/**
 * Prime disconnect audit logs so old actions aren't processed
 * when the bot starts.
 */
async function primeDisconnectAuditLogs(guild) {
  const auditLogs = await guild.fetchAuditLogs({
    type: AuditLogEvent.MemberDisconnect,
    limit: 10,
  });

  for (const entry of auditLogs.entries.values()) {
    const key = getAuditKey(guild.id, entry.id);

    disconnectAuditCounts.set(key, getAuditCount(entry));
  }
}

/**
 * Prime move audit logs so old moves aren't processed
 * when the bot starts.
 */
async function primeMoveAuditLogs(guild) {
  const auditLogs = await guild.fetchAuditLogs({
    type: AuditLogEvent.MemberMove,
    limit: 10,
  });

  for (const entry of auditLogs.entries.values()) {
    const key = getAuditKey(guild.id, entry.id);

    moveAuditCounts.set(key, getAuditCount(entry));
  }
}

/**
 * Find a new moderator disconnect action.
 */
async function findNewDisconnectAction(guild) {
  const maximumAttempts = 12;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 150 : 200);

    const auditLogs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberDisconnect,
      limit: 10,
    });

    let detectedEntry = null;

    for (const entry of auditLogs.entries.values()) {
      const key = getAuditKey(guild.id, entry.id);
      const currentCount = getAuditCount(entry);
      const previousCount = disconnectAuditCounts.get(key);

      const hasExecutor = Boolean(entry.executorId);
      const isBotAction = entry.executorId === client.user.id;

      const existingEntryIncreased =
        previousCount !== undefined &&
        currentCount > previousCount;

      const isRecentNewEntry =
        previousCount === undefined &&
        Date.now() - entry.createdTimestamp <= 10_000;

      if (
        hasExecutor &&
        !isBotAction &&
        (existingEntryIncreased || isRecentNewEntry)
      ) {
        detectedEntry = entry;
        break;
      }
    }

    for (const entry of auditLogs.entries.values()) {
      const key = getAuditKey(guild.id, entry.id);

      disconnectAuditCounts.set(key, getAuditCount(entry));
    }

    if (detectedEntry) {
      return detectedEntry;
    }
  }

  return null;
}

/**
 * Find a new moderator move action.
 *
 * We also check the destination channel to reduce the chance
 * of matching an unrelated move.
 */
async function findNewMoveAction(guild, destinationChannelId) {
  const maximumAttempts = 12;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 150 : 200);

    const auditLogs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberMove,
      limit: 10,
    });

    let detectedEntry = null;

    for (const entry of auditLogs.entries.values()) {
      const key = getAuditKey(guild.id, entry.id);
      const currentCount = getAuditCount(entry);
      const previousCount = moveAuditCounts.get(key);

      const hasExecutor = Boolean(entry.executorId);
      const isBotAction = entry.executorId === client.user.id;

      const existingEntryIncreased =
        previousCount !== undefined &&
        currentCount > previousCount;

      const isRecentNewEntry =
        previousCount === undefined &&
        Date.now() - entry.createdTimestamp <= 10_000;

      const auditDestinationChannelId =
        getMoveDestinationChannelId(entry);

      const destinationMatches =
        !auditDestinationChannelId ||
        auditDestinationChannelId === destinationChannelId;

      if (
        hasExecutor &&
        !isBotAction &&
        destinationMatches &&
        (existingEntryIncreased || isRecentNewEntry)
      ) {
        detectedEntry = entry;
        break;
      }
    }

    // Update our stored counts.
    for (const entry of auditLogs.entries.values()) {
      const key = getAuditKey(guild.id, entry.id);

      moveAuditCounts.set(key, getAuditCount(entry));
    }

    if (detectedEntry) {
      return detectedEntry;
    }
  }

  return null;
}

/**
 * Send a message into the configured text channel.
 */
async function sendProtectionMessage(guild, content) {
  try {
    const messageChannel = await guild.channels
      .fetch(disconnectMessageChannelId)
      .catch(() => null);

    if (!messageChannel || !messageChannel.isSendable()) {
      console.error(
        `Channel ${disconnectMessageChannelId} was not found or cannot receive messages.`
      );
      return;
    }

    await messageChannel.send({
      content,
      allowedMentions: {
        parse: [],
      },
    });

    console.log(`Posted a message in #${messageChannel.name}.`);
  } catch (error) {
    console.error("Failed to post protection message:", error);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Bot logged in as ${readyClient.user.tag}`);

  console.log(
    `Protecting ${protectedUserIds.size} user(s): ${[
      ...protectedUserIds,
    ].join(", ")}`
  );

  console.log(
    `Protection messages will be posted in channel ${disconnectMessageChannelId}.`
  );

  console.log(
    `Idiot corner voice channel: ${idiotCornerChannelId}.`
  );

  for (const guild of readyClient.guilds.cache.values()) {
    try {
      await Promise.all([
        primeDisconnectAuditLogs(guild),
        primeMoveAuditLogs(guild),
      ]);

      console.log(
        `Loaded disconnect and move audit state for ${guild.name}.`
      );
    } catch (error) {
      console.error(
        `Could not load audit state for ${guild.name}:`,
        error
      );
    }
  }
});

/**
 * Load audit state if the bot joins another server.
 */
client.on(Events.GuildCreate, async (guild) => {
  try {
    await Promise.all([
      primeDisconnectAuditLogs(guild),
      primeMoveAuditLogs(guild),
    ]);

    console.log(
      `Loaded disconnect and move audit state for ${guild.name}.`
    );
  } catch (error) {
    console.error(
      `Could not load audit state for ${guild.name}:`,
      error
    );
  }
});

/**
 * Reply with a random message whenever someone mentions the bot.
 */
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    return;
  }

  if (!client.user || !message.mentions.users.has(client.user.id)) {
    return;
  }

  const randomReply =
    randomReplies[Math.floor(Math.random() * randomReplies.length)];

  try {
    await message.reply({
      content: randomReply,
      allowedMentions: {
        repliedUser: false,
      },
    });

    console.log(
      `Replied to a mention from ${message.author.tag} in ${
        message.guild?.name || "a direct message"
      }.`
    );
  } catch (error) {
    console.error("Failed to reply to mention:", error);
  }
});

/**
 * Protect users from forced disconnects AND forced moves.
 */
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const protectedMember = oldState.member;

  if (!protectedMember) {
    return;
  }

  // Only monitor protected users.
  if (!protectedUserIds.has(protectedMember.id)) {
    return;
  }

  // They must already have been in voice.
  if (!oldState.channelId) {
    return;
  }

  // Nothing relevant changed.
  if (oldState.channelId === newState.channelId) {
    return;
  }

  const guild = oldState.guild;

  try {
    const botMember = await guild.members.fetchMe();

    const canViewAuditLog = botMember.permissions.has(
      PermissionsBitField.Flags.ViewAuditLog
    );

    const canMoveMembers = botMember.permissions.has(
      PermissionsBitField.Flags.MoveMembers
    );

    if (!canViewAuditLog || !canMoveMembers) {
      console.error(
        "Bot needs the View Audit Log and Move Members permissions."
      );
      return;
    }

    /*
     * =========================================================
     * PROTECTED USER WAS DISCONNECTED
     * =========================================================
     */
    if (!newState.channelId) {
      console.log(
        `${protectedMember.user.tag} left or was disconnected from voice.`
      );

      const disconnectEntry =
        await findNewDisconnectAction(guild);

      if (!disconnectEntry) {
        console.log(
          `${protectedMember.user.tag} probably left voice themselves.`
        );
        return;
      }

      if (!disconnectEntry.executorId) {
        return;
      }

      const responsibleMember = await guild.members
        .fetch(disconnectEntry.executorId)
        .catch(() => null);

      if (!responsibleMember) {
        console.log(
          `Could not find who disconnected ${protectedMember.user.tag}.`
        );
        return;
      }

      if (!responsibleMember.voice.channelId) {
        console.log(
          `${responsibleMember.user.tag} disconnected ${protectedMember.user.tag}, but they are no longer in voice.`
        );
        return;
      }

      await responsibleMember.voice.disconnect(
        `Automatically disconnected for disconnecting protected user ${protectedMember.user.tag}`
      );

      console.log(
        `Disconnected ${responsibleMember.user.tag} because they disconnected ${protectedMember.user.tag}.`
      );

      await sendProtectionMessage(
        guild,
        `Oh, **${responsibleMember.displayName}**… you really thought you could disconnect **${protectedMember.displayName}** in front of me? Cute. I’ve personally shown you the door. 💅🚪`
      );

      return;
    }

    /*
     * =========================================================
     * PROTECTED USER WAS MOVED
     * =========================================================
     */
    console.log(
      `${protectedMember.user.tag} moved from ${oldState.channelId} to ${newState.channelId}.`
    );

    const moveEntry = await findNewMoveAction(
      guild,
      newState.channelId
    );

    if (!moveEntry) {
      console.log(
        `${protectedMember.user.tag} probably moved themselves.`
      );
      return;
    }

    if (!moveEntry.executorId) {
      console.log(
        "Move audit entry did not contain an executor."
      );
      return;
    }

    const responsibleMember = await guild.members
      .fetch(moveEntry.executorId)
      .catch(() => null);

    if (!responsibleMember) {
      console.log(
        `Could not find who moved ${protectedMember.user.tag}.`
      );
      return;
    }

    console.log(
      `${responsibleMember.user.tag} moved ${protectedMember.user.tag}.`
    );

    // They need to still be connected for us to punish them.
    if (!responsibleMember.voice.channelId) {
      console.log(
        `${responsibleMember.user.tag} moved ${protectedMember.user.tag}, but they are no longer in voice.`
      );
      return;
    }

    // Don't bother if they're already in idiot corner.
    if (
      responsibleMember.voice.channelId === idiotCornerChannelId
    ) {
      console.log(
        `${responsibleMember.user.tag} is already in idiot corner.`
      );
      return;
    }

    const idiotCornerChannel = await guild.channels
      .fetch(idiotCornerChannelId)
      .catch(() => null);

    if (
      !idiotCornerChannel ||
      !idiotCornerChannel.isVoiceBased()
    ) {
      console.error(
        `Idiot corner channel ${idiotCornerChannelId} does not exist or is not a voice channel.`
      );
      return;
    }

    await responsibleMember.voice.setChannel(
      idiotCornerChannel,
      `Moved to idiot corner for moving protected user ${protectedMember.user.tag}`
    );

    console.log(
      `Moved ${responsibleMember.user.tag} to idiot corner because they moved ${protectedMember.user.tag}.`
    );

    await sendProtectionMessage(
      guild,
      `🚨 **${responsibleMember.displayName}** moved **${protectedMember.displayName}** without permission. Enjoy the idiot corner. 🫵😂`
    );
  } catch (error) {
    console.error(
      "Failed to process protected voice action:",
      error
    );
  }
});

client.login(process.env.DISCORD_TOKEN);