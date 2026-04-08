async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  // 1. 글로벌 명령어 전체 삭제
  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: [] }
  );

  // 2. 현재 길드 명령어 전체 삭제
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: [] }
  );

  // 잠깐 대기
  await new Promise((r) => setTimeout(r, 2000));

  // 3. 길드 명령어만 다시 등록
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("✅ 글로벌 명령어 삭제 완료");
  console.log("✅ 길드 명령어 재등록 완료");
}
