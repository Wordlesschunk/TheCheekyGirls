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

// Store the last observed count for each Discord audit-log entry.
const disconnectAuditCounts = new Map();

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

if (protectedUserIds.size === 0) {
  console.error("Missing PROTECTED_USER_IDS in .env");
  process.exit(1);
}

/**
 * Pause execution for a specified amount of time.
 */
function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Create a unique key for an audit-log entry.
 */
function getDisconnectAuditKey(guildId, entryId) {
  return `${guildId}:${entryId}`;
}

/**
 * Get the disconnect count from an audit-log entry.
 */
function getDisconnectCount(entry) {
  const count = Number(entry.extra?.count ?? 1);

  return Number.isFinite(count) ? count : 1;
}

/**
 * Load the current audit-log state when the bot starts.
 *
 * This prevents an old audit-log entry from being mistaken
 * for a new disconnect.
 */
async function primeDisconnectAuditLogs(guild) {
  const auditLogs = await guild.fetchAuditLogs({
    type: AuditLogEvent.MemberDisconnect,
    limit: 10,
  });

  for (const entry of auditLogs.entries.values()) {
    const key = getDisconnectAuditKey(guild.id, entry.id);
    const count = getDisconnectCount(entry);

    disconnectAuditCounts.set(key, count);
  }
}

/**
 * Look for a new moderator disconnect action.
 *
 * Discord sometimes creates a new audit-log entry, but it can also
 * reuse an existing entry and increase its count.
 */
async function findNewDisconnectAction(guild) {
  const maximumAttempts = 8;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    // Give Discord time to update the audit log.
    await sleep(attempt === 0 ? 750 : 500);

    const auditLogs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberDisconnect,
      limit: 10,
    });

    let detectedEntry = null;

    for (const entry of auditLogs.entries.values()) {
      const key = getDisconnectAuditKey(guild.id, entry.id);
      const currentCount = getDisconnectCount(entry);
      const previousCount = disconnectAuditCounts.get(key);

      const isBotAction = entry.executorId === client.user.id;
      const hasExecutor = Boolean(entry.executorId);

      const existingEntryIncreased =
        previousCount !== undefined && currentCount > previousCount;

      const isRecentNewEntry =
        previousCount === undefined &&
        Date.now() - entry.createdTimestamp <= 15_000;

      if (
        hasExecutor &&
        !isBotAction &&
        (existingEntryIncreased || isRecentNewEntry)
      ) {
        detectedEntry = entry;
        break;
      }
    }

    // Save the latest counts after checking for changes.
    for (const entry of auditLogs.entries.values()) {
      const key = getDisconnectAuditKey(guild.id, entry.id);
      const currentCount = getDisconnectCount(entry);

      disconnectAuditCounts.set(key, currentCount);
    }

    if (detectedEntry) {
      return detectedEntry;
    }
  }

  return null;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Bot logged in as ${readyClient.user.tag}`);

  console.log(
    `Protecting ${protectedUserIds.size} user(s): ${[
      ...protectedUserIds,
    ].join(", ")}`
  );

  for (const guild of readyClient.guilds.cache.values()) {
    try {
      await primeDisconnectAuditLogs(guild);

      console.log(`Loaded disconnect audit state for ${guild.name}.`);
    } catch (error) {
      console.error(
        `Could not load disconnect audit state for ${guild.name}:`,
        error
      );
    }
  }
});

/**
 * Load audit-log state if the bot joins another server.
 */
client.on(Events.GuildCreate, async (guild) => {
  try {
    await primeDisconnectAuditLogs(guild);

    console.log(`Loaded disconnect audit state for ${guild.name}.`);
  } catch (error) {
    console.error(
      `Could not load disconnect audit state for ${guild.name}:`,
      error
    );
  }
});

/**
 * Reply with a random message whenever someone mentions the bot.
 */
client.on(Events.MessageCreate, async (message) => {
  // Ignore messages sent by bots.
  if (message.author.bot) {
    return;
  }

  // Only respond when this bot is mentioned.
  if (!message.mentions.users.has(client.user.id)) {
    return;
  }

  const randomReply =
    randomReplies[Math.floor(Math.random() * randomReplies.length)];

  try {
    await message.reply({
      content: randomReply,
      allowedMentions: {
        // Do not ping the person again when replying.
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
 * Detect when a protected user leaves or is disconnected from voice.
 */
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const protectedMember = oldState.member;

  if (!protectedMember) {
    return;
  }

  // Only monitor users listed in PROTECTED_USER_IDS.
  if (!protectedUserIds.has(protectedMember.id)) {
    return;
  }

  // The user must previously have been in a voice channel.
  if (!oldState.channelId) {
    return;
  }

  // Ignore moves between channels.
  // Only continue when the user has left voice completely.
  if (newState.channelId) {
    return;
  }

  const guild = oldState.guild;

  console.log(
    `${protectedMember.user.tag} left or was disconnected from voice.`
  );

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

    const disconnectEntry = await findNewDisconnectAction(guild);

    if (!disconnectEntry) {
      console.log(
        `${protectedMember.user.tag} probably left voice themselves.`
      );
      return;
    }

    const responsibleMember = await guild.members
      .fetch(disconnectEntry.executorId)
      .catch(() => null);

    if (!responsibleMember) {
      console.log(
        `Could not find the user responsible for disconnecting ${protectedMember.user.tag}.`
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
  } catch (error) {
    console.error("Failed to process the voice disconnect:", error);
  }
});

client.login(process.env.DISCORD_TOKEN);