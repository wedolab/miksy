// Фаза 0.2.0, исправления после пятой проверки (out/phase-roots-fixes5.md) — часть 1: B.1 (доверие Claude и ответы
// пользователя в окне Claude) и B.2 (отметка «проект забыт»). Описание и тела тестов — roots-fixes5-help.ts; часть 2 —
// roots-fixes5b.test.ts (круг 10d: разделено на два файла — при --parallel идут одновременно)
import { rf5 } from "./roots-fixes5-help";

rf5(1);
