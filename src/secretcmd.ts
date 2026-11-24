// miksy secret <ИМЯ> (круг 11k): skill получает один секрет из local/secrets.env в трубу — без пути к local/ и без
// чтения всего файла. Выдаются только секреты, объявленные для места текущего каталога: skill_secrets в layer.yaml
// слоёв места (глобальные — везде; дерево — его проектам; привязки map.yaml). Значение — в stdout без перевода строки;
// в терминал — только с --show (человеку). Агент запускает команды без терминала: от вывода значения в чат проверка
// терминала его не защищает — защищают правила skill. Объявление — защита от ошибки, не граница доступа: место
// определяется рабочим каталогом, агент может его сменить (круг 11l, docs/layers.md)
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadSecrets, serviceDir } from "./load";
import { driveRoot, slash } from "./paths";
import { enclosingTarget, globalTarget, layersOf, projectTarget } from "./registry";
import { merge } from "./resolve";
import { locate, machineRoots } from "./roots";
import type { Machine, Resolved, Sourced } from "./types";

export type SecretPlace = { where: string; layers: string[]; names: Sourced<string>[] };

// Секреты для skills места каталога dir: глобальные слои, затем слои места (как explain без пути). Слой у имени —
// первый, где оно объявлено
export function placeSkillSecrets(dir: string, machine: Machine): SecretPlace {
  const abs = slash(realpathSync.native(resolve(driveRoot(dir))));
  if (serviceDir(abs)) throw new Error(`${abs} — служебный каталог miksy (копии, бэкапы, сборки): секреты здесь не выдаются`);
  const roots = machineRoots(machine);
  const place = locate(abs, roots);
  const global = globalTarget(machine).cfg;
  let cfg: Resolved | null = null;
  let where = `вне workspace (${abs}) — только глобальные слои`;
  if (place && !place.rel) {
    cfg = merge(layersOf(place.tree, machine), machine.os);
    where = `корень workspace ${place.abs}`;
  } else if (place) {
    // Цель — как у sync без пути (круг 11l): ближайшая вверх (git-репо, target: true, каталог агента); подпапка цели без
    // git получает слои цели, а не своего места в дереве. Не цель — слои места в дереве
    const p = enclosingTarget(abs, place.root, machine);
    try {
      if (!p) throw new Error("не цель");
      const t = projectTarget(p.abs, p.rel, machine, p.nested);
      cfg = t.cfg;
      where = t.title;
    } catch {
      cfg = merge(layersOf(place.tree, machine), machine.os);
      where = place.tree;
    }
  }
  const names = new Map<string, string>();
  for (const s of [...(global.skillSecrets ?? []), ...(cfg?.skillSecrets ?? [])]) if (!names.has(s.item)) names.set(s.item, s.layer);
  return { where, layers: [...global.layers, ...(cfg?.layers ?? [])], names: [...names].map(([item, layer]) => ({ item, layer })) };
}

// Значение секрета для трубы; ошибка — Error с текстом без значения
export function secretValue(name: string, dir: string, machine: Machine, tty: boolean, show: boolean): string {
  const place = placeSkillSecrets(dir, machine);
  if (!place.names.some((s) => s.item === name)) {
    throw new Error(`секрет ${name} не объявлен для ${place.where} (слои: ${place.layers.join(" → ")}). ` +
      `Объявить — skill_secrets: [${name}] в layers/tree/<организация>[/<проект>]/layer.yaml; в layers/global/layer.yaml — получат skills всех организаций`);
  }
  const secrets = loadSecrets();
  if (!(name in secrets)) throw new Error(`секрет ${name} объявлен, но не задан в local/secrets.env конфигурации — впишите строку ${name}=<значение>`);
  if (tty && !show) throw new Error(`значение в терминал не выводится — используйте в трубе: miksy secret ${name} | <команда>; показать на экране — miksy secret ${name} --show`);
  return secrets[name];
}
