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

// Stores the most recent count for each Discord disconnect audit entry.
const disconnectAuditCounts = new Map();

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

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getDisconnectAuditKey(guildId, entryId) {
  return `${guildId}:${entryId}`;
}

function getDisconnectCount(entry) {
  const count = Number(entry.extra?.count ?? 1);

  return Number.isFinite(count) ? count : 1;
}

/**
 * Save the current disconnect audit-log state.
 *
 * This prevents old audit entries from being mistaken for new actions
 * when the bot starts.
 */
async function primeDisconnectAuditLogs(guild) {
  const auditLogs = await guild.fetchAuditLogs({
    type: AuditLogEvent.MemberDisconnect,
    limit: 10,
  });

  for (const entry of auditLogs.entries.values()) {
    const key = getDisconnectAuditKey(guild.id, entry.id);

    disconnectAuditCounts.set(key, getDisconnectCount(entry));
  }
}

/**
 * Quickly check for a new moderator disconnect action.
 *
 * Discord may either create a new audit entry or increase the count
 * on an existing entry.
 */
async function findNewDisconnectAction(guild) {
  const maximumAttempts = 12;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    // Check after 150ms, then retry every 200ms.
    await sleep(attempt === 0 ? 150 : 200);

    const auditLogs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberDisconnect,
      limit: 10,
    });

    let detectedEntry = null;

    for (const entry of auditLogs.entries.values()) {
      const key = getDisconnectAuditKey(guild.id, entry.id);
      const currentCount = getDisconnectCount(entry);
      const previousCount = disconnectAuditCounts.get(key);

      const hasExecutor = Boolean(entry.executorId);
      const isBotAction = entry.executorId === client.user.id;

      const existingEntryIncreased =
        previousCount !== undefined && currentCount > previousCount;

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

    // Store all of the latest counts after checking for changes.
    for (const entry of auditLogs.entries.values()) {
      const key = getDisconnectAuditKey(guild.id, entry.id);

      disconnectAuditCounts.set(key, getDisconnectCount(entry));
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

  console.log(
    `Disconnect messages will be posted in channel ${disconnectMessageChannelId}.`
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
 * Load the audit-log state if the bot joins another server.
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
 * Detect when a protected user leaves or is disconnected from voice.
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

  // The protected user must previously have been in voice.
  if (!oldState.channelId) {
    return;
  }

  // Ignore moves between voice channels.
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

    if (!disconnectEntry.executorId) {
      console.log("The disconnect audit entry did not contain an executor.");
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

    // Fetch the chosen text channel and post the message there.
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
        content: `Oh, **${responsibleMember.displayName}**… you really thought you could disconnect **${protectedMember.displayName}** in front of me? Cute. I’ve personally shown you the door. 💅🚪`,
        allowedMentions: {
          parse: [],
        },
      });

      console.log(`Posted a message in #${messageChannel.name}.`);
    } catch (messageError) {
      console.error(
        "Failed to post the disconnect message:",
        messageError
      );
    }
  } catch (error) {
    console.error("Failed to process the voice disconnect:", error);
  }
});

client.login(process.env.DISCORD_TOKEN);