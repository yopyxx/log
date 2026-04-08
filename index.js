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
  WebhookClient,
} = require("discord.js");

const TOKEN = (process.env.TOKEN || "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();

if (!TOKEN) throw new Error("TOKEN 환경변수가 비어 있습니다.");
if (!CLIENT_ID) throw new Error("CLIENT_ID 환경변수가 비어 있습니다.");

const DATA_FILE = path.join(__dirname, "mirror-config.json");

/**
 * 데이터 구조
 * {
 *   bridges: {
 *     [sourceChannelId]: {
 *       sourceGuildId: string,
 *       targetGuildId: string,
 *       targetChannelId: string,
 *       webhookId: string,
 *       webhookToken: string,
 *       copyBots: boolean,
 *       createdAt: string
 *     }
 *   }
 * }
 */
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { bridges: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { bridges: {} };
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
    .setDescription("A 채널의 기록을 B 채널로 복사/동기화합니다.")
    .addStringOption((o) =>
      o
        .setName("원본채널id")
        .setDescription("기록을 읽어올 A 서버의 채널 ID")
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("대상채널id")
        .setDescription("기록을 보낼 B 서버의 채널 ID")
        .setRequired(true)
    )
    .addBooleanOption((o) =>
      o
        .setName("과거기록포함")
        .setDescription("기존 기록까지 한 번에 복사할지 여부")
        .setRequired(true)
    )
    .addBooleanOption((o) =>
      o
        .setName("봇메시지포함")
        .setDescription("원본 채널의 봇 메시지도 같이 복사할지 여부")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("이관중지")
    .setDescription("설정된 채널 이관을 중지합니다.")
    .addStringOption((o) =>
      o
        .setName("원본채널id")
        .setDescription("중지할 원본 채널 ID")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("이관목록")
    .setDescription("현재 설정된 이관 목록을 확인합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  // 글로벌 명령어 제거
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  } catch {}

  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ 슬래시 명령어 등록 완료");
}

async function ensureWebhook(targetChannel) {
  const existing = await targetChannel.fetchWebhooks();
  let hook = existing.find((w) => w.owner?.id === client.user.id);

  if (!hook) {
    hook = await targetChannel.createWebhook({
      name: "Channel Mirror Bot",
      reason: "채널 기록 이관용 웹훅 생성",
    });
  }

  return hook;
}

function sanitizeContent(content) {
  if (!content) return "";
  return content;
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

  let header = `📦 **이관 기록**\n`;
  header += `서버: **${guildName}** | 채널: **#${channelName}**\n`;
  header += `작성 시각: ${created}\n`;

  if (message.reference?.messageId) {
    header += `답글 메시지 ID: \`${message.reference.messageId}\`\n`;
  }

  return header;
}

async function mirrorOneMessage(message, bridge) {
  if (!message) return;
  if (!message.author) return;

  if (!bridge.copyBots && message.author.bot) return;

  // 시스템 메시지 제외
  if (message.system) return;

  const webhook = new WebhookClient({
    id: bridge.webhookId,
    token: bridge.webhookToken,
  });

  const files = await downloadAttachments(message);
  const content = sanitizeContent(message.content);
  const header = buildHeader(message);

  const textParts = [];
  textParts.push(header);

  if (content && content.trim().length > 0) {
    textParts.push(content);
  }

  if (message.attachments.size > 0 && files.length === 0) {
    const urls = [...message.attachments.values()].map((a) => a.url).join("\n");
    textParts.push(`첨부파일:\n${urls}`);
  }

  if (message.stickers?.size > 0) {
    const stickerText = [...message.stickers.values()]
      .map((s) => `스티커: ${s.name}`)
      .join("\n");
    textParts.push(stickerText);
  }

  const finalContent = textParts.join("\n\n").slice(0, 1900);

  try {
    await webhook.send({
      content: finalContent || " ",
      username: message.member?.displayName || message.author.globalName || message.author.username,
      avatarURL: message.author.displayAvatarURL({ extension: "png", size: 256 }),
      files,
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    console.error("웹훅 전송 실패:", e);
  }
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

  // Discord는 최신순으로 주므로 오래된 것부터 처리
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all;
}

async function copyHistory(sourceChannel, bridge) {
  const messages = await fetchAllMessages(sourceChannel);

  for (const msg of messages) {
    await mirrorOneMessage(msg, bridge);

    // 과도한 속도 방지
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
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

      if (!sourceChannel || !sourceChannel.isTextBased()) {
        return interaction.editReply("❌ 원본 채널 ID가 올바르지 않거나 텍스트 채널이 아닙니다.");
      }

      if (!targetChannel || !targetChannel.isTextBased()) {
        return interaction.editReply("❌ 대상 채널 ID가 올바르지 않거나 텍스트 채널이 아닙니다.");
      }

      if (!sourceChannel.guild || !targetChannel.guild) {
        return interaction.editReply("❌ 길드(서버) 채널만 지원합니다.");
      }

      const hook = await ensureWebhook(targetChannel);

      db.bridges[sourceChannelId] = {
        sourceGuildId: sourceChannel.guild.id,
        targetGuildId: targetChannel.guild.id,
        targetChannelId: targetChannel.id,
        webhookId: hook.id,
        webhookToken: hook.token,
        copyBots,
        createdAt: new Date().toISOString(),
      };
      saveData(db);

      await interaction.editReply(
        [
          "✅ 이관 설정이 저장되었습니다.",
          `원본: **${sourceChannel.guild.name} / #${sourceChannel.name}**`,
          `대상: **${targetChannel.guild.name} / #${targetChannel.name}**`,
          `과거 기록 복사: **${includeHistory ? "예" : "아니오"}**`,
          `봇 메시지 포함: **${copyBots ? "예" : "아니오"}**`,
          "",
          "이제부터 원본 채널의 새 메시지가 자동으로 대상 채널에 복사됩니다.",
        ].join("\n")
      );

      if (includeHistory) {
        copyHistory(sourceChannel, db.bridges[sourceChannelId]).catch(console.error);
      }
    }

    else if (interaction.commandName === "이관중지") {
      await interaction.deferReply({ ephemeral: true });

      const sourceChannelId = interaction.options.getString("원본채널id", true).trim();
      const bridge = db.bridges[sourceChannelId];

      if (!bridge) {
        return interaction.editReply("❌ 해당 원본 채널에 연결된 이관 설정이 없습니다.");
      }

      delete db.bridges[sourceChannelId];
      saveData(db);

      await interaction.editReply("✅ 이관 설정을 중지했습니다.");
    }

    else if (interaction.commandName === "이관목록") {
      await interaction.deferReply({ ephemeral: true });

      const entries = Object.entries(db.bridges);
      if (!entries.length) {
        return interaction.editReply("현재 설정된 이관이 없습니다.");
      }

      const lines = [];
      for (const [sourceChannelId, bridge] of entries) {
        const sourceChannel = await client.channels.fetch(sourceChannelId).catch(() => null);
        const targetChannel = await client.channels.fetch(bridge.targetChannelId).catch(() => null);

        lines.push(
          [
            `원본: ${sourceChannel ? `${sourceChannel.guild.name} / #${sourceChannel.name}` : sourceChannelId}`,
            `대상: ${targetChannel ? `${targetChannel.guild.name} / #${targetChannel.name}` : bridge.targetChannelId}`,
            `봇 포함: ${bridge.copyBots ? "예" : "아니오"}`,
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
        await interaction.reply({ content: "❌ 명령어 처리 중 오류가 발생했습니다.", ephemeral: true });
      }
    } catch {}
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (!message.channel) return;

    const bridge = db.bridges[message.channel.id];
    if (!bridge) return;

    // 대상 채널에 이미 웹훅으로 들어온 메시지 재복사 방지
    if (message.webhookId) return;

    await mirrorOneMessage(message, bridge);
  } catch (e) {
    console.error("실시간 이관 오류:", e);
  }
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();