// Выпуск 0.2.2, круг 8d, рецензия A №1: свои папки за ссылкой local/backups, которые оставила настоящая v0.2.1, — цель
// ссылки с наследованием прав. Описание и тела тестов — fixes022d-ra-tree-help.ts; цель без наследования и local/secrets —
// fixes022d-ra-tree-2.test.ts (круг 10d: разделено на два файла — при --parallel идут одновременно)
import { raTree } from "./fixes022d-ra-tree-help";

raTree("inherit");
