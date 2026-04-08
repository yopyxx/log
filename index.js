// @ts-nocheck
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  WebhookClient,
} = require("discord.js");

const TOKEN = (process.env.TOKEN || "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();

if (!TOKEN) throw new Error("TOKEN 환경변수가 비어 있습니다.");
if (!CLIENT_ID) throw new Error("CLIENT_ID 환경변수가 비어 있습니다.");

const DATA_FILE = path.join(__dirname, "mirror-config.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { bridges: {}, threadMap: {} };
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { bridges: {}, threadMap: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

const db = loadData();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const commands = [
  new SlashCommandBuilder()
    .setName("이관설정")
    .setDescription("어떤 메시지 채널이든 다른 채널로 기록 이관/동기화합니다.")
    .addStringOption((o) =>
      o.setName("원본채널id").setDescription("원본 채널 ID").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("대상채널id").setDescription("대상 채널 ID").setRequired(true)
    )
    .addBooleanOption((o) =>
      o.setName("과거기록포함").setDescription("기존 기록도 복사").setRequired(true)
    )
    .addBooleanOption((o) =>
      o.setName("봇메시지포함").setDescription("봇 메시지도 포함").setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("이관중지")
    .setDescription("설정된 이관을 중지합니다.")
    .addStringOption((o) =>
      o.setName("원본채널id").setDescription("원본 채널 ID").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("이관목록")
    .setDescription("현재 이관 목록을 확인합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  } catch {}
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ 슬래시 명령어 등록 완료");
}

function isThread(channel) {
  return [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel?.type);
}

function isForumLike(channel) {
  return [
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
  ].includes(channel?.type);
}

function isTextLike(channel) {
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel?.type);
}

function isSupportedSource(channel) {
  return isTextLike(channel) || isForumLike(channel);
}

function isSupportedTarget(channel) {
  return isTextLike(channel) || isForumLike(channel);
}

async function ensureWebhook(channel) {
  if (isThread(channel)) {
    const parent = channel.parent;
    if (!parent) throw new Error("스레드의 부모 채널을 찾을 수 없습니다.");
    channel = parent;
  }

  const hooks = await channel.fetchWebhooks();
  let hook = hooks.find((w) => w.owner?.id === client.user.id);

  if (!hook) {
    hook = await channel.createWebhook({
      name: "Universal Mirror Bot",
      reason: "범용 채널 이관용 웹훅",
    });
  }

  return hook;
}

async function fetchAllMessages(channel) {
  const all = [];
  let lastId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const batch = await channel.messages.fetch(options);
    if (!batch.size) break;

    all.push(...batch.values());
    lastId = batch.last().id;

    if (batch.size < 100) break;
  }

  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all;
}

async function fetchAllActiveAndArchivedThreads(forumChannel) {
  const results = [];

  const active = await forumChannel.threads.fetchActive().catch(() => null);
  if (active?.threads) {
    for (const t of active.threads.values()) results.push(t);
  }

  const archivedPublic = await forumChannel.threads.fetchArchived().catch(() => null);
  if (archivedPublic?.threads) {
    for (const t of archivedPublic.threads.values()) results.push(t);
  }

  const archivedPrivate = await forumChannel.threads.fetchArchived({ type: "private" }).catch(() => null);
  if (archivedPrivate?.threads) {
    for (const t of archivedPrivate.threads.values()) results.push(t);
  }

  const unique = new Map();
  for (const t of results) unique.set(t.id, t);

  return [...unique.values()].sort((a, b) => {
    const at = a.createdTimestamp || 0;
    const bt = b.createdTimestamp || 0;
    return at - bt;
  });
}

async function downloadAttachments(message) {
  const files = [];

  for (const att of message.attachments.values()) {
    try {
      const res = await fetch(att.url);
      if (!res.ok) continue;
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      files.push({
        attachment: buffer,
        name: att.name || `file-${Date.now()}`,
      });
    } catch (e) {
      console.error("첨부파일 다운로드 실패:", e);
    }
  }

  return files;
}

function buildHeader(message) {
  const created = `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`;
  const guildName = message.guild?.name || "알 수 없는 서버";
  const channelName = message.channel?.name || "알 수 없는 채널";

  const parts = [
    `📦 **이관 기록**`,
    `서버: **${guildName}**`,
    `채널: **${channelName}**`,
    `작성 시각: ${created}`,
  ];

  if (message.reference?.messageId) {
    parts.push(`답글 원본 ID: \`${message.reference.messageId}\``);
  }

  return parts.join("\n");
}

function trimContent(text, limit = 1900) {
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) : text;
}

async function sendViaWebhook({
  webhookId,
  webhookToken,
  content,
  username,
  avatarURL,
  files = [],
  threadId,
  threadName,
}) {
  const webhook = new WebhookClient({
    id: webhookId,
    token: webhookToken,
  });

  const payload = {
    content: content || " ",
    username,
    avatarURL,
    files,
    allowedMentions: { parse: [] },
  };

  if (threadId) {
    return await webhook.send({
      ...payload,
      threadId,
    });
  }

  if (threadName) {
    return await webhook.send({
      ...payload,
      threadName,
    });
  }

  return await webhook.send(payload);
}

function getThreadMapKey(bridgeId, sourceThreadId) {
  return `${bridgeId}:${sourceThreadId}`;
}

async function ensureTargetThreadForSourceThread(bridge, sourceThread) {
  const key = getThreadMapKey(bridge.bridgeId, sourceThread.id);
  const already = db.threadMap[key];

  if (already) {
    const thread = await client.channels.fetch(already).catch(() => null);
    if (thread) return thread.id;
  }

  const targetChannel = await client.channels.fetch(bridge.targetChannelId).catch(() => null);
  if (!targetChannel) throw new Error("대상 채널을 찾을 수 없습니다.");

  // 대상이 포럼/미디어면 원본 스레드 이름으로 게시글 생성
  if (isForumLike(targetChannel)) {
    const hook = await ensureWebhook(targetChannel);

    const starterText = [
      `📁 **원본 게시글/스레드 생성**`,
      `서버: **${sourceThread.guild?.name || "알 수 없음"}**`,
      `채널: **${sourceThread.parent?.name || sourceThread.channel?.name || "알 수 없음"}**`,
      `원본 스레드명: **${sourceThread.name || "이름 없음"}**`,
      sourceThread.createdTimestamp
        ? `생성 시각: <t:${Math.floor(sourceThread.createdTimestamp / 1000)}:F>`
        : null,
    ].filter(Boolean).join("\n");

    const createdMsg = await sendViaWebhook({
      webhookId: hook.id,
      webhookToken: hook.token,
      content: trimContent(starterText, 1800),
      username: "Mirror System",
      avatarURL: client.user.displayAvatarURL({ extension: "png", size: 256 }),
      threadName: (sourceThread.name || "이관된 게시글").slice(0, 100),
    });

    const targetThreadId = createdMsg.channelId;
    db.threadMap[key] = targetThreadId;
    saveData(db);
    return targetThreadId;
  }

  // 대상이 일반 텍스트/공지면 스레드 구분용 헤더만 사용
  if (isTextLike(targetChannel)) {
    db.threadMap[key] = targetChannel.id;
    saveData(db);
    return targetChannel.id;
  }

  throw new Error("지원되지 않는 대상 채널 유형입니다.");
}

async function mirrorOneMessage(message, bridge, sourceThread = null) {
  if (!message?.author) return;
  if (message.system) return;
  if (!bridge.copyBots && message.author.bot) return;

  const targetChannel = await client.channels.fetch(bridge.targetChannelId).catch(() => null);
  if (!targetChannel) return;

  const hook = await ensureWebhook(targetChannel);
  const files = await downloadAttachments(message);

  const parts = [];
  if (sourceThread && isTextLike(targetChannel) && !isThread(targetChannel)) {
    parts.push(`🧵 **원본 스레드/게시글:** ${sourceThread.name}`);
  }

  parts.push(buildHeader(message));

  if (message.content?.trim()) {
    parts.push(message.content);
  }

  if (message.attachments.size > 0 && files.length === 0) {
    const urls = [...message.attachments.values()].map((a) => a.url).join("\n");
    parts.push(`첨부파일 URL:\n${urls}`);
  }

  if (message.stickers?.size > 0) {
    parts.push(
      [...message.stickers.values()].map((s) => `스티커: ${s.name}`).join("\n")
    );
  }

  const finalContent = trimContent(parts.join("\n\n"), 1900);

  let threadId = null;

  if (sourceThread) {
    if (isForumLike(targetChannel)) {
      threadId = await ensureTargetThreadForSourceThread(bridge, sourceThread);
    } else if (isThread(targetChannel)) {
      threadId = targetChannel.id;
    }
  } else {
    if (isForumLike(targetChannel)) {
      // 일반 텍스트/공지 → 포럼/미디어 로 보낼 때는 채널명 기준 게시글 1개 생성/재사용
      const virtualSourceId = `root-${bridge.sourceChannelId}`;
      const key = getThreadMapKey(bridge.bridgeId, virtualSourceId);
      const existingTargetThreadId = db.threadMap[key];

      if (existingTargetThreadId) {
        const existingThread = await client.channels.fetch(existingTargetThreadId).catch(() => null);
        if (existingThread) {
          threadId = existingThread.id;
        }
      }

      if (!threadId) {
        const sourceChannel = await client.channels.fetch(bridge.sourceChannelId).catch(() => null);
        const createdMsg = await sendViaWebhook({
          webhookId: hook.id,
          webhookToken: hook.token,
          content: `📁 **원본 채널 기록 시작**\n서버: **${sourceChannel?.guild?.name || "알 수 없음"}**\n채널: **${sourceChannel?.name || "알 수 없음"}**`,
          username: "Mirror System",
          avatarURL: client.user.displayAvatarURL({ extension: "png", size: 256 }),
          threadName: ((sourceChannel?.name || "이관된 채널 기록") + "-기록").slice(0, 100),
        });

        threadId = createdMsg.channelId;
        db.threadMap[key] = threadId;
        saveData(db);
      }
    } else if (isThread(targetChannel)) {
      threadId = targetChannel.id;
    }
  }

  await sendViaWebhook({
    webhookId: hook.id,
    webhookToken: hook.token,
    content: finalContent || " ",
    username:
      message.member?.displayName ||
      message.author.globalName ||
      message.author.username,
    avatarURL: message.author.displayAvatarURL({ extension: "png", size: 256 }),
    files,
    threadId,
  });
}

async function mirrorTextLikeHistory(sourceChannel, bridge) {
  const messages = await fetchAllMessages(sourceChannel);
  for (const msg of messages) {
    await mirrorOneMessage(msg, bridge, isThread(sourceChannel) ? sourceChannel : null);
    await wait(800);
  }
}

async function mirrorForumLikeHistory(sourceForumChannel, bridge) {
  const threads = await fetchAllActiveAndArchivedThreads(sourceForumChannel);

  for (const thread of threads) {
    const messages = await fetchAllMessages(thread);

    for (const msg of messages) {
      await mirrorOneMessage(msg, bridge, thread);
      await wait(800);
    }

    await wait(1200);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

client.once("ready", async () => {
  console.log(`✅ 로그인 완료: ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "이관설정") {
      await interaction.deferReply({ ephemeral: true });

      const sourceChannelId = interaction.options.getString("원본채널id", true).trim();
      const targetChannelId = interaction.options.getString("대상채널id", true).trim();
      const includeHistory = interaction.options.getBoolean("과거기록포함", true);
      const copyBots = interaction.options.getBoolean("봇메시지포함") ?? false;

      const sourceChannel = await client.channels.fetch(sourceChannelId).catch(() => null);
      const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);

      if (!sourceChannel) {
        return await interaction.editReply("❌ 원본 채널을 찾을 수 없습니다.");
      }
      if (!targetChannel) {
        return await interaction.editReply("❌ 대상 채널을 찾을 수 없습니다.");
      }

      if (!isSupportedSource(sourceChannel)) {
        return await interaction.editReply(
          "❌ 원본 채널은 텍스트/공지/포럼/미디어/스레드만 지원합니다."
        );
      }

      if (!isSupportedTarget(targetChannel)) {
        return await interaction.editReply(
          "❌ 대상 채널은 텍스트/공지/포럼/미디어/스레드만 지원합니다."
        );
      }

      const hook = await ensureWebhook(targetChannel);

      const bridgeId = `${sourceChannel.id}->${targetChannel.id}`;

      db.bridges[sourceChannel.id] = {
        bridgeId,
        sourceChannelId: sourceChannel.id,
        sourceGuildId: sourceChannel.guild?.id || null,
        targetChannelId: targetChannel.id,
        targetGuildId: targetChannel.guild?.id || null,
        webhookId: hook.id,
        webhookToken: hook.token,
        copyBots,
        createdAt: new Date().toISOString(),
      };
      saveData(db);

      await interaction.editReply(
        [
          "✅ 이관 설정 완료",
          `원본: **${sourceChannel.guild?.name || "알 수 없음"} / #${sourceChannel.name || sourceChannel.id}**`,
          `대상: **${targetChannel.guild?.name || "알 수 없음"} / #${targetChannel.name || targetChannel.id}**`,
          `원본 유형: **${ChannelType[sourceChannel.type]}**`,
          `대상 유형: **${ChannelType[targetChannel.type]}**`,
          `과거 기록 복사: **${includeHistory ? "예" : "아니오"}**`,
          `봇 메시지 포함: **${copyBots ? "예" : "아니오"}**`,
        ].join("\n")
      );

      if (includeHistory) {
        const bridge = db.bridges[sourceChannel.id];

        if (isForumLike(sourceChannel)) {
          mirrorForumLikeHistory(sourceChannel, bridge).catch(console.error);
        } else {
          mirrorTextLikeHistory(sourceChannel, bridge).catch(console.error);
        }
      }
    }

    else if (interaction.commandName === "이관중지") {
      await interaction.deferReply({ ephemeral: true });

      const sourceChannelId = interaction.options.getString("원본채널id", true).trim();

      if (!db.bridges[sourceChannelId]) {
        return await interaction.editReply("❌ 해당 원본 채널의 이관 설정이 없습니다.");
      }

      const bridgeId = db.bridges[sourceChannelId].bridgeId;
      delete db.bridges[sourceChannelId];

      for (const key of Object.keys(db.threadMap)) {
        if (key.startsWith(`${bridgeId}:`)) {
          delete db.threadMap[key];
        }
      }

      saveData(db);
      await interaction.editReply("✅ 이관 설정을 중지했습니다.");
    }

    else if (interaction.commandName === "이관목록") {
      await interaction.deferReply({ ephemeral: true });

      const entries = Object.values(db.bridges);
      if (!entries.length) {
        return await interaction.editReply("현재 설정된 이관이 없습니다.");
      }

      const lines = [];

      for (const bridge of entries) {
        const sourceChannel = await client.channels.fetch(bridge.sourceChannelId).catch(() => null);
        const targetChannel = await client.channels.fetch(bridge.targetChannelId).catch(() => null);

        lines.push(
          [
            `원본: ${sourceChannel ? `${sourceChannel.guild?.name} / #${sourceChannel.name}` : bridge.sourceChannelId}`,
            `대상: ${targetChannel ? `${targetChannel.guild?.name} / #${targetChannel.name}` : bridge.targetChannelId}`,
            `원본유형: ${sourceChannel ? ChannelType[sourceChannel.type] : "알 수 없음"}`,
            `대상유형: ${targetChannel ? ChannelType[targetChannel.type] : "알 수 없음"}`,
            `봇포함: ${bridge.copyBots ? "예" : "아니오"}`,
            `생성일: ${bridge.createdAt}`,
            "—",
          ].join("\n")
        );
      }

      await interaction.editReply(lines.join("\n"));
    }
  } catch (e) {
    console.error("명령어 처리 오류:", e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ 명령어 처리 중 오류가 발생했습니다.");
      } else {
        await interaction.reply({
          content: "❌ 명령어 처리 중 오류가 발생했습니다.",
          ephemeral: true,
        });
      }
    } catch {}
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.webhookId) return;

    // 1) 원본이 일반 텍스트/공지/스레드인 경우
    const directBridge = db.bridges[message.channel.id];
    if (directBridge) {
      const sourceThread = isThread(message.channel) ? message.channel : null;
      await mirrorOneMessage(message, directBridge, sourceThread);
      return;
    }

    // 2) 원본이 포럼/미디어이고, 그 안의 게시글/스레드에서 메시지가 작성된 경우
    if (isThread(message.channel) && message.channel.parentId) {
      const parentBridge = db.bridges[message.channel.parentId];
      if (parentBridge) {
        await mirrorOneMessage(message, parentBridge, message.channel);
      }
    }
  } catch (e) {
    console.error("실시간 이관 오류:", e);
  }
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
