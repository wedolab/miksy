// Читатели командных skills для тестов разбора (src/teamskills.ts) — таблица, которая до круга 10x-2 была в ядре по
// умолчанию: id агента → каталоги, где агент сам находит skills проекта. Боевые читатели — skillDirs адаптеров
// (src/registry.ts: READERS); тесты разбора проверяют сам разбор на этой фиксированной таблице
import { scanTeamSkills, withTeamSkills } from "../src/teamskills";

export const READERS0: Record<string, string[]> = {
  claude: [".claude/skills"],
  codex: [".agents/skills"],
  opencode: [".agents/skills", ".claude/skills", ".opencode/skills", ".opencode/skill"],
  antigravity: [".gemini/skills"],
};

export const scan0 = (dir: string) => scanTeamSkills(dir, READERS0);
export const withTeam0 = (cfg: Parameters<typeof withTeamSkills>[0], dir: string, agent: string) => withTeamSkills(cfg, dir, agent, READERS0);
