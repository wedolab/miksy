// Разбор аргументов CLI: у каждой команды свой список флагов. Неизвестный флаг, флаг без значения,
// повтор или лишний аргумент — ошибка до любых действий: опечатка в --dry-run не должна приводить к записи.

export class UsageError extends Error {}

interface Spec {
  valued?: string[]; // --name <значение> или --name=<значение>
  bool?: string[]; // --name
  positional: [number, number]; // сколько позиционных аргументов допустимо
  check?: (flags: Record<string, string>, positional: string[]) => void;
}

// Цель sync/clean: ровно одно из — путь, --global, --all
const oneTarget = (flags: Record<string, string>, positional: string[]) => {
  const given = [positional.length > 0 && "<путь>", "global" in flags && "--global", "all" in flags && "--all"].filter(Boolean);
  if (given.length > 1) throw new UsageError(`укажите что-то одно: ${given.join(", ")}`);
};

export const COMMANDS: Record<string, Spec> = {
  setup: { bool: ["yes", "force", "backup"], positional: [0, 0] },
  explain: {
    bool: ["global"], positional: [0, 1],
    check: (f, p) => { if ("global" in f && p.length) throw new UsageError("укажите что-то одно: <путь> или --global"); },
  },
  projects: { valued: ["agent"], positional: [0, 0] },
  skills: {
    valued: ["agent"], bool: ["all"], positional: [0, 1],
    check: (f, p) => { if ("all" in f && p.length) throw new UsageError("укажите что-то одно: <путь> или --all"); },
  },
  sync: {
    valued: ["agent", "out"], bool: ["global", "all", "dry-run", "force", "yes"], positional: [0, 1],
    check: (f, p) => {
      if ("out" in f && ("all" in f || "force" in f)) throw new UsageError("--out — одна цель (путь или --global) и без --force");
      oneTarget(f, p);
    },
  },
  // --forget — забыть записанное в каталог, которого нет (диск не подключён или данных больше нет)
  clean: { valued: ["agent"], bool: ["global", "all", "dry-run", "force", "forget"], positional: [0, 1], check: oneTarget },
  adopt: {
    valued: ["agent", "to"], bool: ["global", "dry-run", "yes"], positional: [1, 2],
    check: (f, p) => {
      if (p.length !== ("global" in f ? 1 : 2))
        throw new UsageError("использование: miksy adopt <путь проекта> <имя> --to <уровень>  |  miksy adopt --global <имя> --to <уровень>");
    },
  },
  doctor: { valued: ["agent"], bool: ["verbose"], positional: [0, 0] },
  target: { bool: ["remove", "dry-run"], positional: [0, 1] },
  // root — список корней; root add [<путь>] [--tree <ветка>]; root remove <путь>
  root: {
    valued: ["tree"], bool: ["dry-run", "forget", "yes"], positional: [0, 2],
    check: (f, p) => {
      const usage = "использование: miksy root add [<путь>] [--tree <ветка>]  |  miksy root remove <путь>  |  miksy root (список корней)";
      if (p.length && p[0] !== "add" && p[0] !== "remove") throw new UsageError(usage);
      if (p[0] === "remove" && p.length !== 2) throw new UsageError("miksy root remove <путь> — укажите, какой корень убрать");
      if ("tree" in f && p[0] !== "add") throw new UsageError("--tree — только для miksy root add");
      if ("forget" in f && p[0] !== "remove") throw new UsageError("--forget — только для miksy root remove");
      if ("yes" in f && p[0] !== "add") throw new UsageError("--yes — только для miksy root add (добавить корнем каталог, который сам проект, без вопроса)");
      if ("dry-run" in f && !p.length) throw new UsageError("--dry-run — для miksy root add и root remove");
    },
  },
  trust: {
    valued: ["agent"], bool: ["confirm", "deny"], positional: [0, 1],
    check: (f) => { if ("confirm" in f && "deny" in f) throw new UsageError("укажите что-то одно: --confirm или --deny"); },
  },
  // --finish --from <версия> — шаги после обновления: их запускает сам update новым кодом движка
  update: {
    valued: ["from"], bool: ["yes", "check", "main", "finish"], positional: [0, 0],
    check: (f) => {
      if ("check" in f && "yes" in f) throw new UsageError("--check только проверяет и ничего не меняет — без --yes");
      if ("from" in f !== "finish" in f) throw new UsageError("--from — только вместе с --finish (их передаёт сам miksy update)");
      if ("finish" in f && ("check" in f || "main" in f || "yes" in f)) throw new UsageError("--finish — внутренний шаг miksy update, без других флагов");
    },
  },
  version: { positional: [0, 0] },
};

export function parseArgs(cmd: string, args: string[]): { flags: Record<string, string>; positional: string[] } {
  const spec = COMMANDS[cmd];
  if (!spec) throw new UsageError(`неизвестная команда «${cmd}»`);
  const valued = new Set(spec.valued ?? []);
  const bool = new Set(spec.bool ?? []);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  const known = () => [...valued].map((f) => `--${f} <значение>`).concat([...bool].map((f) => `--${f}`)).join(", ") || "нет";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-") || a === "-") {
      positional.push(a);
      continue;
    }
    if (!a.startsWith("--")) throw new UsageError(`неизвестный флаг «${a}» для ${cmd}; допустимы: ${known()}`);
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (name in flags) throw new UsageError(`флаг --${name} указан дважды`);
    if (valued.has(name)) {
      const value = eq < 0 ? args[++i] : a.slice(eq + 1);
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--")))
        throw new UsageError(`флагу --${name} нужно значение: --${name} <значение> или --${name}=<значение>`);
      flags[name] = value;
    } else if (bool.has(name)) {
      if (eq >= 0) throw new UsageError(`флаг --${name} не принимает значение`);
      flags[name] = "";
    } else {
      throw new UsageError(`неизвестный флаг «${a}» для ${cmd}; допустимы: ${known()}`);
    }
  }
  const [min, max] = spec.positional;
  if (positional.length > max) throw new UsageError(`лишние аргументы для ${cmd}: ${positional.slice(max).join(" ")}`);
  if (positional.length < min) throw new UsageError(`${cmd}: не хватает аргументов`);
  spec.check?.(flags, positional);
  return { flags, positional };
}
