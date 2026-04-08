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

/* =========================
   환경변수
========================= */
const TOKEN = (process.env.TOKEN || "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || "").trim();

if (!TOKEN) throw new Error("TOKEN 환경변수가 비어 있습니다.");
if (!CLIENT_ID) throw new Error("CLIENT_ID 환경변수가 비어 있습니다.");
if (!GUILD_ID) throw new Error("GUILD_ID 환경변수가 비어 있습니다.");

/* =========================
   파일 경로
========================= */
const DATA_FILE = path.join(__dirname, "mirror-config.json");

/* =========================
   저장 구조
========================= */
/**
 * {
 *   bridges: {
 *     [sourceChannelId]: {
 *       bridgeId: string,
 *       sourceChannelId: string,
 *       sourceGuildId: string | null,
 *       targetChannelId: string,
 *       targetGuildId: string | null,
 *       webhookId: string,
 *       webhookToken: string,
 *       copyBots: boolean,
 *       createdAt: string,
 *       lastHistoryRunAt?: string
 *     }
 *   },
 *   threadMap: {
 *     [bridgeId:sourceThreadId]: targetThreadId
 *   },
 *   messageMap: {
 *     [bridgeId:sourceMessageId]: targetMessageId
 *   }
 * }
 */

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return {
      bridges: {},
      threadMap: {},
      messageMap: {},
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      bridges: raw.bridges || {},
      threadMap: raw.threadMap || {},
      messageMap: raw.messageMap || {},
    };
  } catch {
    return {
      bridges: {},
      threadMap: {},
      messageMap: {},
    };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

const db = loadData();

/* =========================
   클라이언트
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

/* =========================
   명령어
========================= */
const commands = [
  new SlashCommandBuilder()
    .setName("이관설정")
    .setDescription("원본 채널 기록을 대상 채널로 이관/동기화합니다.")
    .addStringOption((o) =>
      o
        .setName("원본채널id")
        .setDescription("기록을 읽을 채널 ID")
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("대상채널id")
        .setDescription("기록을 보낼 채널 ID")
        .setRequired(true)
    )
    .addBooleanOption((o) =>
      o
        .setName("과거기록포함")
        .setDescription("기존 기록도 함께 복사할지")
        .setRequired(true)
    )
    .addBooleanOption((o) =>
      o
        .setName("봇메시지포함")
        .setDescription("봇 메시지도 복사할지")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("이관중지")
    .setDescription("설정된 이관을 중지합니다.")
    .addStringOption((o) =>
      o
        .setName("원본채널id")
        .setDescription("중지할 원본 채널 ID")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("이관목록")
    .setDescription("현재 설정된 이관 목록을 표시합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("과거기록재실행")
    .setDescription("특정 원본 채널의 과거 기록 복사를 다시 실행합니다.")
    .addStringOption((o) =>
      o
        .setName("원본채널id")
        .setDescription("재실행할 원본 채널 ID")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("✅ 길드 슬래시 명령어 등록 완료");
}

/* =========================
   유틸
========================= */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimText(text, limit = 1900) {
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) : text;
}

function safeChannelLabel(channel) {
  if (!channel) return "알 수 없음";
  return channel.name ? `#${channel.name}` : channel.id;
}

function safeGuildLabel(channel) {
  return channel?.guild?.name || "알 수 없는 서버";
}

function getThreadMapKey(bridgeId, sourceThreadId) {
  return `${bridgeId}:${sourceThreadId}`;
}

function getMessageMapKey(bridgeId, sourceMessageId) {
  return `${bridgeId}:${sourceMessageId}`;
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

function buildHeader(message) {
  const created = `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`;
  const parts = [
    `📦 **이관 기록**`,
    `서버: **${safeGuildLabel(message.channel)}**`,
    `채널: **${safeChannelLabel(message.channel)}**`,
    `작성 시각: ${created}`,
  ];

  if (message.reference?.messageId) {
    parts.push(`답글 원본 ID: \`${message.reference.messageId}\``);
  }

  return parts.join("\n");
}

/* =========================
   웹훅
========================= */
async function ensureWebhook(targetChannel) {
  let baseChannel = targetChannel;

  if (isThread(targetChannel)) {
    if (!targetChannel.parent) {
      throw new Error("스레드의 부모 채널을 찾을 수 없습니다.");
    }
    baseChannel = targetChannel.parent;
  }

  const hooks = await baseChannel.fetchWebhooks();
  let hook = hooks.find((w) => w.owner?.id === client.user.id);

  if (!hook) {
    hook = await baseChannel.createWebhook({
      name: "Universal Mirror Bot",
      reason: "채널 기록 이관용 웹훅",
    });
  }

  return hook;
}

async function sendViaWebhook({
  webhookId,
  webhookToken,
  username,
  avatarURL,
  content,
  files = [],
  threadId,
  threadName,
}) {
  const webhook = new WebhookClient({
    id: webhookId,
    token: webhookToken,
  });

  const payload = {
    username,
    avatarURL,
    content: content || " ",
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

/* =========================
   첨부파일
========================= */
async function downloadAttachments(message) {
  const files = [];

  for (const att of message.attachments.values()) {
    try {
      const res = await fetch(att.url);
      if (!res.ok) continue;

      const ab = await res.arrayBuffer();
      const buffer = Buffer.from(ab);

      files.push({
        attachment: buffer,
        name: att.name || `file-${Date.now()}`,
      });
    } catch (err) {
      console.error("첨부파일 다운로드 실패:", err);
    }
  }

  return files;
}

/* =========================
   메시지 / 스레드 조회
========================= */
async function fetchAllMessages(channel) {
  const all = [];
  let lastId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const batch = await channel.messages.fetch(options).catch(() => null);
    if (!batch || !batch.size) break;

    all.push(...batch.values());
    lastId = batch.last().id;

    if (batch.size < 100) break;

    await wait(300);
  }

  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all;
}

async function fetchForumThreads(forumChannel) {
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
  for (const thread of results) {
    unique.set(thread.id, thread);
  }

  return [...unique.values()].sort((a, b) => {
    const at = a.createdTimestamp || 0;
    const bt = b.createdTimestamp || 0;
    return at - bt;
  });
}

/* =========================
   대상 스레드 생성/재사용
========================= */
async function ensureTargetThreadForSourceThread(bridge, sourceThread) {
  const key = getThreadMapKey(bridge.bridgeId, sourceThread.id);
  const existingThreadId = db.threadMap[key];

  if (existingThreadId) {
    const existing = await client.channels.fetch(existingThreadId).catch(() => null);
    if (existing) return existing.id;
  }

  const targetChannel = await client.channels.fetch(bridge.targetChannelId).catch(() => null);
  if (!targetChannel) throw new Error("대상 채널을 찾을 수 없습니다.");

  if (isForumLike(targetChannel)) {
    const hook = await ensureWebhook(targetChannel);

    const starter = [
      `📁 **원본 게시글/스레드 생성**`,
      `원본 서버: **${sourceThread.guild?.name || "알 수 없음"}**`,
      `원본 채널: **${sourceThread.parent?.name || "알 수 없음"}**`,
      `원본 스레드명: **${sourceThread.name || "이름 없음"}**`,
      sourceThread.createdTimestamp
        ? `생성 시각: <t:${Math.floor(sourceThread.createdTimestamp / 1000)}:F>`
        : null,
    ].filter(Boolean).join("\n");

    const created = await sendViaWebhook({
      webhookId: hook.id,
      webhookToken: hook.token,
      username: "Mirror System",
      avatarURL: client.user.displayAvatarURL({ extension: "png", size: 256 }),
      content: trimText(starter, 1800),
      threadName: (sourceThread.name || "이관된 게시글").slice(0, 100),
    });

    db.threadMap[key] = created.channelId;
    saveData(db);
    return created.channelId;
  }

  if (isThread(targetChannel)) {
    db.threadMap[key] = targetChannel.id;
    saveData(db);
    return targetChannel.id;
  }

  if (isTextLike(targetChannel)) {
    db.threadMap[key] = targetChannel.id;
    saveData(db);
    return targetChannel.id;
  }

  throw new Error("지원되지 않는 대상 채널 유형입니다.");
}

async function ensureRootTargetThread(bridge) {
  const virtualSourceId = `root-${bridge.sourceChannelId}`;
  const key = getThreadMapKey(bridge.bridgeId, virtualSourceId);
  const existingThreadId = db.threadMap[key];

  if (existingThreadId) {
    const existing = await client.channels.fetch(existingThreadId).catch(() => null);
    if (existing) return existing.id;
  }

  const sourceChannel = await client.channels.fetch(bridge.sourceChannelId).catch(() => null);
  const targetChannel = await client.channels.fetch(bridge.targetChannelId).catch(() => null);
  if (!targetChannel) throw new Error("대상 채널을 찾을 수 없습니다.");

  if (isForumLike(targetChannel)) {
    const hook = await ensureWebhook(targetChannel);

    const starter = [
      `📁 **원본 채널 기록 시작**`,
      `원본 서버: **${sourceChannel?.guild?.name || "알 수 없음"}**`,
      `원본 채널: **${sourceChannel?.name || sourceChannel?.id || "알 수 없음"}**`,
    ].join("\n");

    const created = await sendViaWebhook({
      webhookId: hook.id,
      webhookToken: hook.token,
      username: "Mirror System",
      avatarURL: client.user.displayAvatarURL({ extension: "png", size: 256 }),
      content: trimText(starter, 1800),
      threadName: ((sourceChannel?.name || "이관기록") + "-기록").slice(0, 100),
    });

    db.threadMap[key] = created.channelId;
    saveData(db);
    return created.channelId;
  }

  if (isThread(targetChannel)) {
    db.threadMap[key] = targetChannel.id;
    saveData(db);
    return targetChannel.id;
  }

  if (isTextLike(targetChannel)) {
    db.threadMap[key] = targetChannel.id;
    saveData(db);
    return targetChannel.id;
  }

  throw new Error("지원되지 않는 대상 채널 유형입니다.");
}

/* =========================
   단일 메시지 복사
========================= */
async function mirrorOneMessage(message, bridge, sourceThread = null) {
  if (!message?.author) return;
  if (!message.channel) return;
  if (message.system) return;
  if (!bridge.copyBots && message.author.bot) return;

  const key = getMessageMapKey(bridge.bridgeId, message.id);
  if (db.messageMap[key]) return; // 중복 복사 방지

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

  if (message.stickers?.size > 0) {
    parts.push(
      [...message.stickers.values()]
        .map((s) => `스티커: ${s.name}`)
        .join("\n")
    );
  }

  if (message.attachments.size > 0 && files.length === 0) {
    const urls = [...message.attachments.values()].map((a) => a.url).join("\n");
    parts.push(`첨부파일 URL:\n${urls}`);
  }

  const finalContent = trimText(parts.join("\n\n"), 1900);

  let threadId = null;

  if (sourceThread) {
    threadId = await ensureTargetThreadForSourceThread(bridge, sourceThread);
  } else {
    if (isForumLike(targetChannel) || isThread(targetChannel)) {
      threadId = await ensureRootTargetThread(bridge);
    }
  }

  const sent = await sendViaWebhook({
    webhookId: hook.id,
    webhookToken: hook.token,
    username:
      message.member?.displayName ||
      message.author.globalName ||
      message.author.username,
    avatarURL: message.author.displayAvatarURL({ extension: "png", size: 256 }),
    content: finalContent || " ",
    files,
    threadId,
  });

  db.messageMap[key] = sent.id;
  saveData(db);
}

/* =========================
   과거 기록 복사
========================= */
async function mirrorTextLikeHistory(sourceChannel, bridge) {
  const messages = await fetchAllMessages(sourceChannel);

  for (const msg of messages) {
    try {
      await mirrorOneMessage(msg, bridge, isThread(sourceChannel) ? sourceChannel : null);
      await wait(900);
    } catch (err) {
      console.error("텍스트 채널 기록 복사 실패:", err);
      await wait(1500);
    }
  }

  db.bridges[sourceChannel.id].lastHistoryRunAt = new Date().toISOString();
  saveData(db);
}

async function mirrorForumLikeHistory(sourceForumChannel, bridge) {
  const threads = await fetchForumThreads(sourceForumChannel);

  for (const thread of threads) {
    try {
      const messages = await fetchAllMessages(thread);

      for (const msg of messages) {
        try {
          await mirrorOneMessage(msg, bridge, thread);
          await wait(900);
        } catch (err) {
          console.error("포럼 스레드 메시지 복사 실패:", err);
          await wait(1500);
        }
      }

      await wait(1200);
    } catch (err) {
      console.error("포럼 스레드 처리 실패:", err);
      await wait(1500);
    }
  }

  db.bridges[sourceForumChannel.id].lastHistoryRunAt = new Date().toISOString();
  saveData(db);
}

async function startHistoryCopy(sourceChannelId) {
  const bridge = db.bridges[sourceChannelId];
  if (!bridge) return;

  const sourceChannel = await client.channels.fetch(sourceChannelId).catch(() => null);
  if (!sourceChannel) return;

  console.log(`📦 과거 기록 복사 시작: ${sourceChannelId}`);

  if (isForumLike(sourceChannel)) {
    await mirrorForumLikeHistory(sourceChannel, bridge);
  } else {
    await mirrorTextLikeHistory(sourceChannel, bridge);
  }

  console.log(`✅ 과거 기록 복사 완료: ${sourceChannelId}`);
}

/* =========================
   준비 체크
========================= */
async function validateBridgeChannels(sourceChannel, targetChannel) {
  if (!sourceChannel) {
    return "❌ 원본 채널을 찾을 수 없습니다.";
  }

  if (!targetChannel) {
    return "❌ 대상 채널을 찾을 수 없습니다.";
  }

  if (!isSupportedSource(sourceChannel)) {
    return "❌ 원본 채널은 텍스트/공지/포럼/미디어/스레드만 지원합니다.";
  }

  if (!isSupportedTarget(targetChannel)) {
    return "❌ 대상 채널은 텍스트/공지/포럼/미디어/스레드만 지원합니다.";
  }

  return null;
}

/* =========================
   이벤트
========================= */
client.once("ready", async () => {
  console.log(`✅ 로그인 완료: ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // 가장 먼저 응답 예약
    await interaction.deferReply({ ephemeral: true });

    if (interaction.commandName === "이관설정") {
      const sourceChannelId = interaction.options.getString("원본채널id", true).trim();
      const targetChannelId = interaction.options.getString("대상채널id", true).trim();
      const includeHistory = interaction.options.getBoolean("과거기록포함", true);
      const copyBots = interaction.options.getBoolean("봇메시지포함") ?? false;

      const sourceChannel = await client.channels.fetch(sourceChannelId).catch(() => null);
      const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);

      const validationError = await validateBridgeChannels(sourceChannel, targetChannel);
      if (validationError) {
        return await interaction.editReply(validationError);
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
          "✅ 이관 설정이 저장되었습니다.",
          `원본: **${safeGuildLabel(sourceChannel)} / ${safeChannelLabel(sourceChannel)}**`,
          `대상: **${safeGuildLabel(targetChannel)} / ${safeChannelLabel(targetChannel)}**`,
          `원본 유형: **${ChannelType[sourceChannel.type]}**`,
          `대상 유형: **${ChannelType[targetChannel.type]}**`,
          `과거 기록 복사: **${includeHistory ? "예" : "아니오"}**`,
          `봇 메시지 포함: **${copyBots ? "예" : "아니오"}**`,
          "",
          "이제부터 새 메시지는 자동으로 대상 채널에 복사됩니다.",
          includeHistory ? "과거 기록 복사도 곧 시작됩니다." : "",
        ].filter(Boolean).join("\n")
      );

      if (includeHistory) {
        setTimeout(() => {
          startHistoryCopy(sourceChannel.id).catch((err) => {
            console.error("과거 기록 복사 실행 오류:", err);
          });
        }, 100);
      }

      return;
    }

    if (interaction.commandName === "이관중지") {
      const sourceChannelId = interaction.options.getString("원본채널id", true).trim();
      const bridge = db.bridges[sourceChannelId];

      if (!bridge) {
        return await interaction.editReply("❌ 해당 원본 채널의 이관 설정이 없습니다.");
      }

      delete db.bridges[sourceChannelId];

      for (const key of Object.keys(db.threadMap)) {
        if (key.startsWith(`${bridge.bridgeId}:`)) {
          delete db.threadMap[key];
        }
      }

      for (const key of Object.keys(db.messageMap)) {
        if (key.startsWith(`${bridge.bridgeId}:`)) {
          delete db.messageMap[key];
        }
      }

      saveData(db);
      return await interaction.editReply("✅ 이관 설정을 중지했습니다.");
    }

    if (interaction.commandName === "이관목록") {
      const entries = Object.values(db.bridges);

      if (!entries.length) {
        return await interaction.editReply("현재 설정된 이관이 없습니다.");
      }

      const lines = [];

      for (const bridge of entries) {
        const sourceChannel = await client.channels.fetch(bridge.sourceChannelId).catch(() => null);
        const targetChannel = await client.channels.fetch(bridge.targetChannelId).catch(() => null);

        lines.push([
          `원본: ${sourceChannel ? `${safeGuildLabel(sourceChannel)} / ${safeChannelLabel(sourceChannel)}` : bridge.sourceChannelId}`,
          `대상: ${targetChannel ? `${safeGuildLabel(targetChannel)} / ${safeChannelLabel(targetChannel)}` : bridge.targetChannelId}`,
          `원본유형: ${sourceChannel ? ChannelType[sourceChannel.type] : "알 수 없음"}`,
          `대상유형: ${targetChannel ? ChannelType[targetChannel.type] : "알 수 없음"}`,
          `봇메시지 포함: ${bridge.copyBots ? "예" : "아니오"}`,
          `생성일: ${bridge.createdAt}`,
          `최근 과거기록 실행: ${bridge.lastHistoryRunAt || "없음"}`,
          "—",
        ].join("\n"));
      }

      return await interaction.editReply(trimText(lines.join("\n"), 1900));
    }

    if (interaction.commandName === "과거기록재실행") {
      const sourceChannelId = interaction.options.getString("원본채널id", true).trim();
      const bridge = db.bridges[sourceChannelId];

      if (!bridge) {
        return await interaction.editReply("❌ 해당 원본 채널의 이관 설정이 없습니다.");
      }

      await interaction.editReply("✅ 과거 기록 복사를 다시 시작합니다.");

      setTimeout(() => {
        startHistoryCopy(sourceChannelId).catch((err) => {
          console.error("과거 기록 재실행 오류:", err);
        });
      }, 100);

      return;
    }
  } catch (err) {
    console.error("명령어 처리 오류:", err);

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

/* =========================
   실시간 메시지 복사
========================= */
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (!message.channel) return;
    if (message.webhookId) return;

    // 일반 텍스트 / 공지 / 스레드 직접 연결
    const directBridge = db.bridges[message.channel.id];
    if (directBridge) {
      const sourceThread = isThread(message.channel) ? message.channel : null;
      await mirrorOneMessage(message, directBridge, sourceThread);
      return;
    }

    // 포럼/미디어 안의 게시글(스레드)에서 메시지 생성된 경우
    if (isThread(message.channel) && message.channel.parentId) {
      const parentBridge = db.bridges[message.channel.parentId];
      if (parentBridge) {
        await mirrorOneMessage(message, parentBridge, message.channel);
      }
    }
  } catch (err) {
    console.error("실시간 메시지 이관 오류:", err);
  }
});

/* =========================
   실행
========================= */
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();