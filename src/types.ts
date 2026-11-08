import type { Root } from "./roots";

export type Os = "windows" | "macos" | "linux";

export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  os?: Os[];
  // Особенности конкретного агента: не подключать или подмешать сырые настройки
  agents?: Record<string, "skip" | { raw: Record<string, unknown> }>;
}

export interface Instruction {
  file: string;
  path: string;
}

export interface Skill {
  name: string;
  dir: string;
  team?: boolean; // импортирован из репо проекта
  patch?: Record<string, string>; // путь внутри skill → исправленное содержимое
  // Готовые файлы (импорт командных skills — из последнего коммита git); если заданы, dir не читается
  files?: { rel: string; content: string; executable: boolean; binary?: boolean }[];
}

// Импорт командных skills: auto — все, но не больше лимита на проект; all — все;
// список имён; false — выключен
export type ImportSkills = "auto" | "all" | string[] | false;

export interface Layer {
  name: string;
  dir: string;
  description?: string;
  exclude: string[];
  importSkills?: ImportSkills;
  trust?: TrustSetting; // доверие проектов слоя: false — miksy не ставит (и снимает своё)
  target?: boolean; // слой дерева: его каталог workspace — цель-группа (target: true в layer.yaml)
  instructions: Instruction[];
  skills: Skill[];
  mcp: McpServer[];
}

export type TrustSetting = { codex?: boolean; claude?: boolean };

export interface MapEntry {
  use: string;
  match?: string;
  os?: Os | Os[];
}

export interface MiksyMap {
  global: MapEntry[];
  layers: MapEntry[];
  skillPrefix?: string; // префикс своих skills (skill_prefix): подсказка adopt
  tools?: Record<string, Tool>; // программы машины, на которые ссылаются MCP слоёв (${ИМЯ}): ищет setup
}

// Программа машины: команды для поиска в PATH и как установить по ОС (команда или ссылка)
export interface Tool {
  find: string[];
  install?: Partial<Record<Os, string>>;
}

export interface Machine {
  workspace: string; // основной (первый) корень: ${WORKSPACE} у целей любого корня и в глобальных настройках
  // Все корни workspace (local/machine.yaml: workspace — строка или список); loadMachine задаёт всегда,
  // без него — один корень workspace (machineRoots)
  roots?: Root[];
  os: Os;
  home: string;
  vars: Record<string, string>;
  agents?: string[]; // агенты, установленные на этой машине (local/machine.yaml)
  trust?: TrustSetting; // по умолчанию добавлять доверие доставленным проектам
}

export interface Sourced<T> {
  item: T;
  layer: string;
}

export interface Resolved {
  layers: string[];
  instructions: Sourced<Instruction>[];
  skills: Sourced<Skill>[];
  mcp: Sourced<McpServer>[];
  importSkills?: Sourced<ImportSkills>;
  // Доверие по агентам — самый конкретный слой, где оно задано
  trust?: { codex?: Sourced<boolean>; claude?: Sourced<boolean> };
  skillExcludes?: string[]; // exclude: skill.* — действует и на импорт командных skills
  below?: Below; // цель ниже цели-группы: что агенты, читающие родительские каталоги, получат от групп
  notes: string[];
}

// Цель ниже цели-группы (Р4). Агент, который сам читает файлы родительских каталогов, получает
// склеиваемое (правила) от групп выше; цель доставляет ему только свой отрезок — слои между
// ближайшей группой выше (не включая) и собой (включая). Сливаемое по имени (skills, MCP) — полным
// набором, но исключённое (exclude) в отрезке всё равно придёт из файлов группы — leaked
export interface Below {
  groups: { rel: string; dir: string; layers: string[]; instructions: boolean }[]; // группы выше, ближняя — последней
  layers: string[]; // слои отрезка
  instructions: Sourced<Instruction>[]; // инструкции отрезка
  // Исключено в цели (exclude отрезка), но лежит в файлах группы выше: kind.name и чья группа
  leaked: { kind: "instructions" | "skills" | "mcp"; name: string; group: string }[];
}
