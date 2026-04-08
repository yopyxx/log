// index.js
// Node.js + discord.js v14
// 기능:
// /기록이동 원본채널ID 대상채널ID 방식(copy|move)
// - 텍스트 채널 메시지 복사
// - 일반 채널의 스레드 복사
// - 포럼 채널(게시글/스레드) 복사
//
// 주의:
// 1) 봇은 원본/대상 서버 모두에 있어야 함
// 2) 원본 채널 읽기 권한, 대상 채널 쓰기 권한 필요
// 3) "move"는 복사 후 원본 삭제를 시도하지만, 실패할 수 있음
// 4) 포럼 -> 텍스트 / 텍스트 -> 포럼 / 스레드 -> 텍스트 등의 경우
//    Discord 구조 차이 때문에 "최대한 비슷하게" 복제함

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  WebhookClient,
} = require("discord.js");

const TOKEN = (process.env.TOKEN || "").replace(/^Bot\s+/i, "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || "").trim(); // 명령어 등록용 서버

if (!TOKEN) throw new Error("TOKEN 환경변수가 비어 있습니다.");
if (!CLIENT_ID) throw new Error("CLIENT_ID 환경변수가 비어 있습니다.");
if (!GUILD_ID) throw new Error("GUILD_ID 환경변수가 비어 있습니다.");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- Slash Command ----------
const commands = [
  new SlashCommandBuilder()
    .setName("기록이동")
    .setDescription("원본 채널 기록을 대상 채널로 복사/이동합니다.")
    .addStringOption((o) =>
      o
        .setName("원본채널id")
        .setDescription("복사할 원본 채널 ID")
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("대상채널id")
        .setDescription("붙여넣을 대상 채널 ID")
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("방식")
        .setDescription("copy 또는 move")
        .setRequired(false)
        .addChoices(
          { name: "copy", value: "copy" },
          { name: "move", value: "move" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ---------- Util ----------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTextLikeChannel(channel) {
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type);
}

function isForumLikeChannel(channel) {
  return [ChannelType.GuildForum].includes(channel.type);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function trimText(text, max = 1800) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function messageHeader(msg) {
  const authorTag = msg.author
    ? `${msg.author.username}${msg.author.discriminator && msg.author.discriminator !== "0" ? "#" + msg.author.discriminator : ""}`
    : "알 수 없음";
  return `**원본 작성자:** ${authorTag}\n**원본 시각(KST):** ${formatDate(msg.createdAt)}`;
}

function buildMessagePayload(msg) {
  const parts = [];

  parts.push(messageHeader(msg));

  if (msg.content?.trim()) {
    parts.push(msg.content);
  }

  // 스티커
  if (msg.stickers?.size) {
    const stickerLine = [...msg.stickers.values()]
      .map((s) => `스티커: ${s.name}`)
      .join("\n");
    parts.push(stickerLine);
  }

  // 임베드 요약
  if (msg.embeds?.length) {
    const embedLines = msg.embeds.map((e, i) => {
      const lines = [`[임베드 ${i + 1}]`];
      if (e.title) lines.push(`제목: ${e.title}`);
      if (e.description) lines.push(`설명: ${e.description}`);
      if (e.url) lines.push(`링크: ${e.url}`);
      return lines.join("\n");
    });
    parts.push(embedLines.join("\n\n"));
  }

  // 첨부 링크 보조 표기
  if (msg.attachments?.size) {
    const attachmentLines = [...msg.attachments.values()].map(
      (a) => `첨부: ${a.name || "file"}\n${a.url}`
    );
    parts.push(attachmentLines.join("\n"));
  }

  return trimText(parts.filter(Boolean).join("\n\n"), 1900);
}

function extractRemoteFiles(msg) {
  if (!msg.attachments?.size) return [];
  return [...msg.attachments.values()]
    .filter((a) => !!a.url)
    .map((a) => ({
      attachment: a.url,
      name: a.name || "file",
    }));
}

async function ensureWebhook(channel) {
  if (!channel || typeof channel.fetchWebhooks !== "function") {
    throw new Error("대상 채널에서 웹훅을 사용할 수 없습니다.");
  }

  const hooks = await channel.fetchWebhooks();
  let hook =
    hooks.find((h) => h.owner?.id === channel.client.user.id) ||
    hooks.find((h) => h.token);

  if (!hook) {
    hook = await channel.createWebhook({
      name: "History Copier",
      reason: "기록 복사용 웹훅 생성",
    });
  }

  return new WebhookClient({ id: hook.id, token: hook.token });
}

async function fetchAllMessages(channel) {
  const collected = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });

    if (!batch.size) break;

    const arr = [...batch.values()];
    collected.push(...arr);
    before = arr[arr.length - 1].id;

    if (batch.size < 100) break;
    await sleep(350);
  }

  // 오래된 순으로 정렬
  collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return collected;
}

async function fetchAllArchivedThreads(channel, type = "public") {
  const all = [];
  let before = undefined;

  while (true) {
    const res = await channel.threads.fetchArchived({
      type,
      fetchAll: false,
      ...(before ? { before } : {}),
      limit: 100,
    });

    const threads = [...res.threads.values()];
    if (!threads.length) break;

    all.push(...threads);

    if (!res.hasMore) break;
    before = threads[threads.length - 1].id;
    await sleep(350);
  }

  return all;
}

async function fetchAllThreadsFromChannel(channel) {
  const result = [];

  // active threads
  try {
    const active = await channel.threads.fetchActive();
    result.push(...active.threads.values());
  } catch (_) {}

  // public archived
  try {
    const pub = await fetchAllArchivedThreads(channel, "public");
    result.push(...pub);
  } catch (_) {}

  // private archived
  try {
    const pri = await fetchAllArchivedThreads(channel, "private");
    result.push(...pri);
  } catch (_) {}

  // 중복 제거
  const uniq = new Map();
  for (const t of result) uniq.set(t.id, t);

  return [...uniq.values()].sort((a, b) => {
    const at = a.createdTimestamp || 0;
    const bt = b.createdTimestamp || 0;
    return at - bt;
  });
}

async function copyMessageToTextTarget(msg, targetChannel, webhook) {
  const files = extractRemoteFiles(msg);
  const content = buildMessagePayload(msg);

  await webhook.send({
    content,
    username: msg.author?.username || "Unknown",
    avatarURL: msg.author?.displayAvatarURL?.({ extension: "png", size: 256 }) || undefined,
    files,
    allowedMentions: { parse: [] },
  });

  await sleep(400);
}

async function copyMessagesToTextChannel(messages, targetChannel) {
  const webhook = await ensureWebhook(targetChannel);

  for (const msg of messages) {
    // 시스템 메시지 등은 텍스트 요약으로만
    await copyMessageToTextTarget(msg, targetChannel, webhook);
  }
}

async function createForumPostFromThread(sourceThread, targetForumChannel) {
  const msgs = await fetchAllMessages(sourceThread);

  const starter = msgs[0];
  const rest = msgs.slice(1);

  const threadName = sourceThread.name || `복사됨-${sourceThread.id}`;
  const starterContent = starter
    ? buildMessagePayload(starter)
    : `원본 스레드 제목: ${threadName}\n원본 생성 시각(KST): ${formatDate(
        sourceThread.createdAt || new Date()
      )}`;

  const starterFiles = starter ? extractRemoteFiles(starter) : [];

  const created = await targetForumChannel.threads.create({
    name: threadName,
    message: {
      content: starterContent,
      files: starterFiles,
      allowedMentions: { parse: [] },
    },
    reason: `스레드/포럼 기록 복사: ${sourceThread.id}`,
  });

  await sleep(800);

  // forum post 내부 후속 메시지 전송
  const webhook = await ensureWebhook(targetForumChannel);

  for (const msg of rest) {
    await webhook.send({
      threadId: created.id,
      content: buildMessagePayload(msg),
      username: msg.author?.username || "Unknown",
      avatarURL: msg.author?.displayAvatarURL?.({ extension: "png", size: 256 }) || undefined,
      files: extractRemoteFiles(msg),
      allowedMentions: { parse: [] },
    });
    await sleep(450);
  }
}

async function copyForumChannelToText(sourceForum, targetText) {
  const posts = await fetchAllThreadsFromChannel(sourceForum);
  const webhook = await ensureWebhook(targetText);

  for (const post of posts) {
    await webhook.send({
      content: `# [포럼 글 시작] ${post.name}\n원본 포럼: <#${sourceForum.id}>\n원본 스레드 ID: ${post.id}`,
      username: "Forum Copier",
      allowedMentions: { parse: [] },
    });
    await sleep(500);

    const messages = await fetchAllMessages(post);
    for (const msg of messages) {
      await webhook.send({
        content: buildMessagePayload(msg),
        username: msg.author?.username || "Unknown",
        avatarURL: msg.author?.displayAvatarURL?.({ extension: "png", size: 256 }) || undefined,
        files: extractRemoteFiles(msg),
        allowedMentions: { parse: [] },
      });
      await sleep(400);
    }

    await webhook.send({
      content: `# [포럼 글 종료] ${post.name}`,
      username: "Forum Copier",
      allowedMentions: { parse: [] },
    });
    await sleep(700);
  }
}

async function copyTextChannelToForum(sourceText, targetForum) {
  // 일반 채널 메시지 전체를 하나의 forum post로 묶음
  const messages = await fetchAllMessages(sourceText);

  if (!messages.length) {
    await targetForum.threads.create({
      name: `${sourceText.name}-복사본`,
      message: {
        content: `원본 채널 <#${sourceText.id}> 에 복사할 메시지가 없습니다.`,
      },
      reason: "빈 채널 복사",
    });
    return;
  }

  const starter = messages[0];
  const rest = messages.slice(1);

  const created = await targetForum.threads.create({
    name: `${sourceText.name}-복사본`,
    message: {
      content: buildMessagePayload(starter),
      files: extractRemoteFiles(starter),
      allowedMentions: { parse: [] },
    },
    reason: `텍스트 채널 기록 복사: ${sourceText.id}`,
  });

  await sleep(800);

  const webhook = await ensureWebhook(targetForum);

  for (const msg of rest) {
    await webhook.send({
      threadId: created.id,
      content: buildMessagePayload(msg),
      username: msg.author?.username || "Unknown",
      avatarURL: msg.author?.displayAvatarURL?.({ extension: "png", size: 256 }) || undefined,
      files: extractRemoteFiles(msg),
      allowedMentions: { parse: [] },
    });
    await sleep(450);
  }

  // 원본 채널의 스레드들도 각각 forum post로 복사
  const sourceThreads = await fetchAllThreadsFromChannel(sourceText);
  for (const t of sourceThreads) {
    await createForumPostFromThread(t, targetForum);
    await sleep(800);
  }
}

async function copyThreadToText(sourceThread, targetText) {
  const webhook = await ensureWebhook(targetText);

  await webhook.send({
    content: `# [스레드 시작] ${sourceThread.name}\n원본 스레드 ID: ${sourceThread.id}`,
    username: "Thread Copier",
    allowedMentions: { parse: [] },
  });
  await sleep(500);

  const messages = await fetchAllMessages(sourceThread);
  for (const msg of messages) {
    await webhook.send({
      content: buildMessagePayload(msg),
      username: msg.author?.username || "Unknown",
      avatarURL: msg.author?.displayAvatarURL?.({ extension: "png", size: 256 }) || undefined,
      files: extractRemoteFiles(msg),
      allowedMentions: { parse: [] },
    });
    await sleep(400);
  }

  await webhook.send({
    content: `# [스레드 종료] ${sourceThread.name}`,
    username: "Thread Copier",
    allowedMentions: { parse: [] },
  });
}

async function deleteSourceMessages(messages) {
  for (const msg of messages) {
    try {
      await msg.delete();
      await sleep(250);
    } catch (_) {
      // 권한/시스템메시지/오래된메시지/기타 실패는 무시
    }
  }
}

async function runCopyOrMove(sourceChannel, targetChannel, mode = "copy") {
  let copiedMessages = 0;
  let copiedThreads = 0;

  if (isForumLikeChannel(sourceChannel)) {
    if (isForumLikeChannel(targetChannel)) {
      const posts = await fetchAllThreadsFromChannel(sourceChannel);
      for (const post of posts) {
        await createForumPostFromThread(post, targetChannel);
        copiedThreads++;
      }
    } else if (isTextLikeChannel(targetChannel)) {
      const posts = await fetchAllThreadsFromChannel(sourceChannel);
      for (const post of posts) {
        const msgs = await fetchAllMessages(post);
        copiedMessages += msgs.length;
      }
      await copyForumChannelToText(sourceChannel, targetChannel);
    } else {
      throw new Error("지원하지 않는 대상 채널 타입입니다.");
    }
    return { copiedMessages, copiedThreads };
  }

  if (sourceChannel.isThread?.()) {
    if (isForumLikeChannel(targetChannel)) {
      await createForumPostFromThread(sourceChannel, targetChannel);
      copiedThreads++;
    } else if (isTextLikeChannel(targetChannel)) {
      const msgs = await fetchAllMessages(sourceChannel);
      copiedMessages += msgs.length;
      await copyThreadToText(sourceChannel, targetChannel);
    } else {
      throw new Error("지원하지 않는 대상 채널 타입입니다.");
    }

    if (mode === "move") {
      const msgs = await fetchAllMessages(sourceChannel);
      await deleteSourceMessages(msgs);
    }

    return { copiedMessages, copiedThreads };
  }

  if (isTextLikeChannel(sourceChannel)) {
    if (isTextLikeChannel(targetChannel)) {
      const messages = await fetchAllMessages(sourceChannel);
      copiedMessages += messages.length;
      await copyMessagesToTextChannel(messages, targetChannel);

      const threads = await fetchAllThreadsFromChannel(sourceChannel);
      for (const t of threads) {
        const msgs = await fetchAllMessages(t);
        copiedMessages += msgs.length;
        copiedThreads++;
        await copyThreadToText(t, targetChannel);
      }

      if (mode === "move") {
        await deleteSourceMessages(messages);
        for (const t of threads) {
          const msgs = await fetchAllMessages(t);
          await deleteSourceMessages(msgs);
        }
      }
    } else if (isForumLikeChannel(targetChannel)) {
      const messages = await fetchAllMessages(sourceChannel);
      copiedMessages += messages.length;

      const threads = await fetchAllThreadsFromChannel(sourceChannel);
      copiedThreads += threads.length;
      for (const t of threads) {
        const msgs = await fetchAllMessages(t);
        copiedMessages += msgs.length;
      }

      await copyTextChannelToForum(sourceChannel, targetChannel);

      if (mode === "move") {
        await deleteSourceMessages(messages);
        for (const t of threads) {
          const msgs = await fetchAllMessages(t);
          await deleteSourceMessages(msgs);
        }
      }
    } else {
      throw new Error("지원하지 않는 대상 채널 타입입니다.");
    }

    return { copiedMessages, copiedThreads };
  }

  throw new Error("지원하지 않는 원본 채널 타입입니다.");
}

// ---------- Events ----------
client.once("ready", async () => {
  console.log(`로그인 완료: ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands.map((c) => c.toJSON()),
  });

  console.log("슬래시 명령어 등록 완료");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "기록이동") return;

  const sourceId = interaction.options.getString("원본채널id", true).trim();
  const targetId = interaction.options.getString("대상채널id", true).trim();
  const mode = interaction.options.getString("방식") || "copy";

  await interaction.deferReply({ ephemeral: true });

  try {
    const sourceChannel = await client.channels.fetch(sourceId);
    const targetChannel = await client.channels.fetch(targetId);

    if (!sourceChannel) {
      return interaction.editReply("❌ 원본 채널을 찾지 못했습니다.");
    }
    if (!targetChannel) {
      return interaction.editReply("❌ 대상 채널을 찾지 못했습니다.");
    }
    if (sourceChannel.id === targetChannel.id) {
      return interaction.editReply("❌ 원본 채널과 대상 채널이 같습니다.");
    }

    await interaction.editReply(
      `⏳ 작업 시작\n- 원본: ${sourceChannel.name || sourceChannel.id}\n- 대상: ${targetChannel.name || targetChannel.id}\n- 방식: ${mode}`
    );

    const result = await runCopyOrMove(sourceChannel, targetChannel, mode);

    await interaction.editReply(
      `✅ 작업 완료\n- 방식: ${mode}\n- 복사된 메시지 수: ${result.copiedMessages}\n- 복사된 스레드/포럼 수: ${result.copiedThreads}`
    );
  } catch (err) {
    console.error(err);
    await interaction.editReply(
      `❌ 작업 실패: ${err.message || "알 수 없는 오류"}`
    );
  }
});

client.login(TOKEN);