// Документация движка для тестов, которые сверяют рецепты с текстом: README.md и все docs/*.md одним текстом (круг
// 10a, справка: README разнесён на несколько файлов — рецепт ищется там, куда переехал его раздел)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ENGINE_DIR = join(import.meta.dir, "..");
export const DOC_FILES = ["README.md", ...readdirSync(join(ENGINE_DIR, "docs")).filter((f) => f.endsWith(".md")).sort().map((f) => `docs/${f}`)];
export const readDocs = () => DOC_FILES.map((f) => readFileSync(join(ENGINE_DIR, f), "utf8")).join("\n\n");
