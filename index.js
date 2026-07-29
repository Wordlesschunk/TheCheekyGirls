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
  "What do you want?",
  "You rang?",
  "I have been summoned.",
  "Behave yourself.",
  "Someone getting disconnected again?",
  "I am watching the voice channels 👀",
  "Do not make me disconnect you.",
  "Leave me alone.",
  "Hello there.",
  "Beep boop.",
];

// Prevent the same audit-log action being handled more than once.
const processedAuditActions = new Set();

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

if (protectedUserIds.size === 0) {
  console.error("Missing PROTECTED_USER_IDS in .env");
  process.exit(1);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Bot logged in as ${readyClient.user.tag}`);

  console.log(
    `Protecting ${protectedUserIds.size} user(s): ${[
      ...protectedUserIds,
    ].join(", ")}`
  );
});

/**
 * Reply with a random message whenever someone mentions the bot.
 */
client.on(Events.MessageCreate, async (message) => {
  // Ignore all messages sent by bots.
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
      `Replied to a mention from ${message.author.tag} in ${message.guild?.name || "a direct message"}.`
    );
  } catch (error) {
    console.error("Failed to reply to mention:", error);
  }
});

/**
 * Detect when a protected user is disconnected from voice.
 */
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const protectedMember = oldState.member;

  if (!protectedMember) {
    return;
  }

  // Only listen for users in the protected list.
  if (!protectedUserIds.has(protectedMember.id)) {
    return;
  }

  // They must have previously been in voice.
  if (!oldState.channelId) {
    return;
  }

  // Ignore channel moves. Only detect leaving voice completely.
  if (newState.channelId) {
    return;
  }

  const guild = oldState.guild;
  const disconnectTime = Date.now();

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

    // Give Discord time to create the audit-log entry.
    setTimeout(async () => {
      try {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.MemberDisconnect,
          limit: 5,
        });

        const disconnectEntry = auditLogs.entries.find((entry) => {
          if (!entry.executorId) {
            return false;
          }

          // Never react to the bot's own actions.
          if (entry.executorId === client.user.id) {
            return false;
          }

          const entryAge = disconnectTime - entry.createdTimestamp;

          // Audit entry must have appeared around the voice disconnect.
          return entryAge >= -3000 && entryAge <= 7000;
        });

        if (!disconnectEntry) {
          console.log(
            `${protectedMember.user.tag} probably left voice themselves.`
          );
          return;
        }

        const actionCount = disconnectEntry.extra?.count || 1;
        const actionKey = `${disconnectEntry.id}:${actionCount}`;

        if (processedAuditActions.has(actionKey)) {
          return;
        }

        processedAuditActions.add(actionKey);

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
          `Disconnected ${responsibleMember.user.tag} because they disconnected protected user ${protectedMember.user.tag}.`
        );
      } catch (error) {
        console.error("Failed to process the disconnect:", error);
      }
    }, 1500);
  } catch (error) {
    console.error("Voice-state handler failed:", error);
  }
});

client.login(process.env.DISCORD_TOKEN);
