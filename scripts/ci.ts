// Проверка GitHub (GitHub Actions) для коммита перед выпуском (scripts/release.ts, круг 10g): выпуск — только когда
// все задания проверки этого коммита завершились успешно. Состояние — check-runs коммита: через gh (если есть и
// вошёл), иначе публичный API без входа (репо публичный, один запрос). Сеть подменяется в тестах (deps)

export type CheckRun = { name: string; status: string; conclusion: string | null; html_url?: string };
export type Slug = { owner: string; repo: string };
// Ответ GitHub: задания проверки или причина, почему их не узнать
export type Runs = { runs: CheckRun[] } | { error: string };
export type Verdict = { ok: boolean; text: string };

// Владелец и репо из адреса origin: https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com/o/r
export function githubSlug(url: string): Slug | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export const actionsUrl = (s: Slug, sha: string) => `https://github.com/${s.owner}/${s.repo}/commit/${sha}/checks`;

type Deps = {
  // gh api <путь>: код выхода и вывод; null — gh нет
  gh: (path: string) => { code: number; out: string } | null;
  // Публичный API: JSON ответа или исключение (сеть)
  http: (url: string) => Promise<{ status: number; json: unknown }>;
};

const realDeps: Deps = {
  gh: (path) => {
    if (!Bun.which("gh")) return null;
    const r = Bun.spawnSync(["gh", "api", path], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { code: r.exitCode ?? -1, out: r.stdout.toString() };
  },
  http: async (url) => {
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "miksy-release" }, signal: AbortSignal.timeout(20000) });
    return { status: res.status, json: await res.json().catch(() => null) };
  },
};

const runsOf = (json: unknown): CheckRun[] | null => {
  const list = (json as { check_runs?: unknown } | null)?.check_runs;
  return Array.isArray(list) ? (list as CheckRun[]) : null;
};

// Задания проверки коммита: gh (вход есть — без лимита публичного API), не вышло — публичный API
export async function checkRuns(s: Slug, sha: string, deps: Deps = realDeps): Promise<Runs> {
  const path = `repos/${s.owner}/${s.repo}/commits/${sha}/check-runs?per_page=100`;
  const viaGh = deps.gh(path);
  if (viaGh && viaGh.code === 0) {
    try { const runs = runsOf(JSON.parse(viaGh.out)); if (runs) return { runs }; } catch { /* ниже — публичный API */ }
  }
  try {
    const r = await deps.http(`https://api.github.com/${path}`);
    const runs = runsOf(r.json);
    if (r.status === 200 && runs) return { runs };
    if (r.status === 403 || r.status === 429) return { error: `GitHub отказал (код ${r.status}, вероятно лимит запросов без входа) — войдите в gh (gh auth login) или повторите позже` };
    if (r.status === 404) return { error: `GitHub не нашёл ${s.owner}/${s.repo} или коммит (код 404) — репо закрытый? Войдите в gh: gh auth login` };
    return { error: `GitHub ответил кодом ${r.status}` };
  } catch (e) {
    return { error: `GitHub недоступен (${(e as Error).message}) — проверьте сеть и повторите` };
  }
}

// Успешно завершённые задания; пропущенные и «нейтральные» не мешают выпуску
const GOOD = new Set(["success", "skipped", "neutral"]);
// Имена заданий без повторов: у коммита бывает несколько запусков одной проверки (пуш main и тега)
const names = (runs: CheckRun[]) => [...new Set(runs.map((c) => c.name))].join(", ");

export function verdict(r: Runs, link: string): Verdict {
  if ("error" in r) return { ok: false, text: `статус проверки GitHub не узнать: ${r.error}` };
  if (!r.runs.length) return { ok: false, text: `у коммита нет запусков проверки GitHub — запушен ли он и запущены ли Actions? ${link}` };
  const running = r.runs.filter((c) => c.status !== "completed");
  if (running.length) return { ok: false, text: `проверка GitHub ещё идёт (${names(running)}) — повторите позже: ${link}` };
  const bad = r.runs.filter((c) => !GOOD.has(c.conclusion ?? ""));
  if (bad.length) return { ok: false, text: `проверка GitHub не прошла: ${[...new Set(bad.map((c) => `${c.name} — ${c.conclusion ?? "без итога"}`))].join("; ")}. Почините и запушьте исправление: ${link}` };
  return { ok: true, text: `проверка GitHub зелёная (${names(r.runs)}): ${link}` };
}
