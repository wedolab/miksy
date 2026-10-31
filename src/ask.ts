// Вопросы пользователю — для мастера setup и подтверждений команд (sync, adopt, trust). Логика задаёт
// вопросы через Ask, не зная, откуда ответ: в терминале — prompt (terminalAsk), в тестах — сценарий
export interface Ask {
  // «Да/нет»: явный ответ (y, yes, д, да / n, no, н, нет); Enter и конец ввода — def (по умолчанию — нет).
  // def = true — для рекомендованных безопасных шагов (копия настроек, PATH, команда miksy)
  yes(question: string, def?: boolean): boolean;
  // Выбор варианта по ключу; Enter — def; нет def или конец ввода — null
  choose(question: string, options: { key: string; label: string }[], def?: string): string | null;
  // Строка как есть (обрезаны пробелы по краям); Enter и конец ввода — null
  line(question: string): string | null;
}

export const isYes = (a: string | null | undefined) => !!a && /^(y|yes|д|да)$/i.test(a.trim());
// Ответ на «да/нет»: пусто — def, иное (не «да») — нет
export const answerYes = (a: string | null | undefined, def = false) => (a?.trim() ? isYes(a) : def);

// prompt Bun возвращает null и на пустой Enter, и на конец ввода — их не различить: оба — ответ по
// умолчанию. Неверный ответ в выборе переспрашивается не больше трёх раз
export const terminalAsk: Ask = {
  yes: (q, def = false) => answerYes(prompt(`${q} ${def ? "[Y/n]" : "[y/N]"}`), def),
  choose(q, options, def) {
    console.log(q);
    for (const o of options) console.log(`  ${o.key} — ${o.label}`);
    for (let i = 0; i < 3; i++) {
      const a = prompt(`Ваш выбор${def ? ` [${def}]` : ""}:`)?.trim() ?? "";
      if (!a) return def ?? null;
      const hit = options.find((o) => o.key.toLowerCase() === a.toLowerCase());
      if (hit) return hit.key;
      console.log(`  нет такого варианта: ${a}`);
    }
    return def ?? null;
  },
  line: (q) => prompt(q)?.trim() || null,
};
