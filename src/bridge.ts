#!/usr/bin/env bun
// Мост MCP stdio ↔ Streamable HTTP — для агентов без подстановок в конфиге MCP (Antigravity) и для
// секрета в URL. Для агента — обычный stdio-сервер (запускается обёрткой, src/launch.ts); запросы
// пересылает POST-ом на HTTP-сервер с заголовками, значения секретов в которых читает из файлов
// local/secrets/<ИМЯ>.
//   bun bridge.ts --name <имя> --secrets <каталог> --url <шаблон> [--header <Имя>=<шаблон>]… [--timeout <с>]
// Шаблон — текст с {secret:ИМЯ}. Обёртка запускает мост как `bun --no-env-file --config=<пустой>` из
// каталога секретов и сбрасывает прокси/TLS-переменные: .env, bunfig.toml (preload) и прокси проекта,
// в котором агент открыл сессию, в процесс с секретами не попадают.
// Значения секретов наружу не выходят: всё, что мост пишет в stdout и stderr (в том числе ответы
// сервера и ошибки среды), проходит маскировку значений → <secret:ИМЯ> (src/mask.ts): сообщение JSON-RPC —
// по строкам до сериализации (jsonrpc, id, method не трогаются: числовой id, совпавший со значением,
// остаётся id; короткое значение — только строкой целиком), диагностика — как текст; адрес в
// сообщениях — из шаблона.
// Ответ сервера — JSON или SSE на тот же POST. Ответ с id запроса передаётся агенту сразу (барьер
// initialize снимается им, а не концом потока); остаток потока читается в фоне. Уведомление (без id)
// завершается по статусу и заголовкам ответа, его тело — в фоне: открытый поток не держит барьер.
// Каждый запрос с id получает ответ: результат сервера или ошибку JSON-RPC (сбой, редирект, битый или
// оборванный поток, таймаут, 202/204). 404 на запрос с сессией — восстановление: повторный initialize с
// параметрами агента и notifications/initialized; новая сессия публикуется только после обоих, запросы
// старой сессии (в том числе поздние 404) ждут его; неудачное восстановление повторяется не чаще RETRY.
// Не поддерживается: редиректы (не выполняются — секретные заголовки уходят только на адрес из слоя);
// отдельный GET-поток сервера — мост его не открывает: уведомления и запросы сервера вне ответа на
// POST до агента не доходят, а 202/204 на запрос с id — ошибка JSON-RPC; устаревший транспорт
// HTTP+SSE (2024-11-05) — ошибка на initialize.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { maskText, maskValue, type Values } from "./mask";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const name = opt("--name") ?? "mcp";
const dir = opt("--secrets") ?? "";
// Ожидание ответа на запрос (и жизнь потока ответа), с; после EOF stdin — не дольше GRACE
const timeout = Math.max(1, Number(opt("--timeout") ?? 600) || 600) * 1000;
const GRACE = Math.min(5000, timeout);
const SECRET = /\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g;
// Повтор неудачного восстановления сессии — не чаще, мс
const RETRY = 5000;

// Подставленные значения: наружу — меткой (как есть, в JSON- и URL-форме)
const values = new Map<string, string>();
const known = (): Values => [...values];
const log = (msg: string) => process.stderr.write(maskText(`miksy bridge ${name}: ${msg}`, known()) + "\n");
const fail = (msg: string): never => {
  log(msg);
  process.exit(1);
};
// Необработанная ошибка среды (Bun печатает её с полным URL) — только маскированный текст
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
process.on("uncaughtException", (e) => fail(`внутренняя ошибка: ${text(e)}`));
process.on("unhandledRejection", (e) => log(`внутренняя ошибка: ${text(e)}`));

const fill = (tpl: string) =>
  tpl.replace(SECRET, (_, n: string) => {
    let v: string;
    try {
      v = readFileSync(join(dir, n), "utf8").replace(/\r?\n$/, "");
    } catch {
      return fail(`нет файла секрета ${n} в ${dir} — выполните miksy sync`);
    }
    values.set(n, v);
    return v;
  });

const urlTpl = opt("--url") ?? fail("не задан --url");
const url = fill(urlTpl);
const headers: Record<string, string> = {};
argv.forEach((a, i) => {
  if (a !== "--header") return;
  const h = argv[i + 1] ?? "";
  const eq = h.indexOf("=");
  if (eq <= 0) fail(`--header без «Имя=значение»`);
  headers[h.slice(0, eq)] = fill(h.slice(eq + 1));
});
try {
  new URL(url);
} catch {
  fail("url не разбирается");
}
// Адрес для сообщений — из шаблона: секрет в имени хоста не попадает в текст ошибки
const host = urlTpl.replace(SECRET, (_, n: string) => `<secret:${n}>`).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#][\s\S]*$/, "").replace(/^[\s\S]*@/, "");

// session — готовая сессия: от initialize агента или после полного восстановления (initialize и
// initialized); кандидат восстановления сюда не попадает
let session: string | undefined;
let protocol: string | undefined;
let initParams: unknown; // параметры initialize агента — для повторной инициализации после 404
const active = new Set<AbortController>();
// Сообщение агенту: строки маскируются до сериализации; служебные поля JSON-RPC — как есть
const out = (m: unknown) => process.stdout.write(JSON.stringify(maskValue(m, known(), ["jsonrpc", "id", "method"])) + "\n");
const error = (id: unknown, message: string) => {
  if (id !== undefined && id !== null) out({ jsonrpc: "2.0", id, error: { code: -32000, message: maskText(`miksy bridge: ${message}`, known()) } });
  log(message);
};

// SSE: события разделены пустой строкой, data: строки события склеиваются через \n
async function readSse(body: ReadableStream<Uint8Array>, onMessage: (m: unknown) => void) {
  const dec = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  const flush = () => {
    if (data.length) {
      try {
        onMessage(JSON.parse(data.join("\n")));
      } catch {
        log("событие SSE не JSON — пропущено");
      }
    }
    data = [];
  };
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(buf[i] === "\r" ? i + 2 : i + 1);
      if (line === "") flush();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  flush();
}

// Итог одного POST для запроса: ответ передан агенту / принято без ответа (уведомление) / сессия
// истекла (404 на запрос с сессией) / ошибка — текст для агента
type Outcome = ({ kind: "answer" } | { kind: "accepted" } | { kind: "gone"; stale: string } | { kind: "error"; message: string }) & { session?: string };

// Один POST. Ответ с id запроса — итог сразу; уведомление (без id) — итог по статусу и заголовкам;
// остальное из потока — deliver в фоне, пока сервер не закроет поток (или не истечёт timeout).
// via — восстановление: своя сессия-кандидат и версия протокола вместо готовых; итог несёт session из
// заголовка ответа (initialize агента публикует её сразу: его запросы и так ждут барьер)
function send(msg: any, deliver: (m: any) => void, via?: { session?: string; protocol?: string }): Promise<Outcome> {
  const id = msg?.method !== undefined ? msg?.id : undefined; // ответ агента на запрос сервера ответа не ждёт
  const ctl = new AbortController();
  active.add(ctl);
  const timer = setTimeout(() => ctl.abort(), timeout);
  return new Promise<Outcome>((resolve) => {
    let done = false;
    let got: string | undefined;
    const finish = (o: Outcome) => {
      if (!done) resolve({ ...o, ...(got && { session: got }) });
      done = true;
    };
    (async () => {
      const sent = via ? via.session : session;
      const version = via ? via.protocol : protocol;
      const res = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: ctl.signal,
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sent && { "mcp-session-id": sent }),
          ...(version && { "mcp-protocol-version": version }),
        },
        body: JSON.stringify(msg),
      });
      got = res.headers.get("mcp-session-id") ?? undefined;
      if (msg?.method === "initialize" && !via) session = got ?? session;
      const drop = () => res.body?.cancel().catch(() => {});
      if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
        await drop();
        return finish({ kind: "error", message: `${host} ответил редиректом (HTTP ${res.status}) — мост редиректы не выполняет: секретные заголовки уходят только на адрес из слоя; исправьте url в слое` });
      }
      if (res.status === 404 && sent && msg?.method !== "initialize") {
        await drop();
        return finish({ kind: "gone", stale: sent });
      }
      if (res.status === 202 || res.status === 204) {
        await drop();
        return finish(id === undefined ? { kind: "accepted" } : { kind: "error", message: `${host} ответил ${res.status} без ответа на запрос — ответ пришёл бы по отдельному GET-потоку, его мост не поддерживает` });
      }
      if (!res.ok) {
        const legacy = msg?.method === "initialize" && [404, 405].includes(res.status) ? " (устаревший транспорт HTTP+SSE мост не поддерживает)" : "";
        await drop();
        return finish({ kind: "error", message: `HTTP ${res.status} от ${host}${res.status === 401 || res.status === 403 ? " — проверьте токен в local/secrets.env и miksy sync" : ""}${legacy}` });
      }
      // Уведомление принято: ответ ему не нужен, тело (возможно, открытый поток) — в фоне
      if (id === undefined) finish({ kind: "accepted" });
      const take = (m: any) => {
        deliver(m);
        if (id !== undefined && m?.id === id && (m?.result !== undefined || m?.error !== undefined)) finish({ kind: "answer" });
      };
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream") && res.body) await readSse(res.body, take);
      else if (type.includes("application/json")) {
        const body = await res.json().catch(() => undefined);
        if (body === undefined) return finish({ kind: "error", message: `ответ ${host} не JSON` });
        for (const m of Array.isArray(body) ? body : [body]) take(m);
      } else {
        await drop();
        if (id !== undefined) return finish({ kind: "error", message: `неожиданный ответ ${host}: ${type || "без content-type"}` });
      }
      finish(id === undefined ? { kind: "accepted" } : { kind: "error", message: `${host} закрыл ответ, не ответив на запрос (поток оборван или событие повреждено)` });
    })()
      .catch((e) => finish({ kind: "error", message: ctl.signal.aborted ? `${host} не ответил за ${timeout / 1000} с` : `${host} недоступен: ${text(e)}` }))
      .finally(() => {
        clearTimeout(timer);
        active.delete(ctl);
      });
  });
}

// Сессия истекла (404): одно восстановление на истёкшую сессию — повторный initialize без сессии и
// notifications/initialized с сессией-кандидатом; готовой она становится только после обоих. Все
// запросы этой сессии, включая поздние 404, присоединяются к текущему восстановлению. Неудача не
// кешируется навсегда: следующий 404 через RETRY — новая попытка (сессия остаётся прежней, её 404
// снова приведёт сюда). null — сессия восстановлена (или уже другая), иначе текст ошибки
let renewing: { stale: string; done: Promise<string | null> } | null = null;
let failed: { stale: string; at: number; why: string } | null = null;
let renewals = 0;
function renew(stale: string): Promise<string | null> {
  if (renewing?.stale === stale) return renewing.done;
  if (session !== stale) return Promise.resolve(null);
  if (failed?.stale === stale && Date.now() - failed.at < RETRY) return Promise.resolve(failed.why);
  const done = (async (): Promise<string | null> => {
    if (initParams === undefined) return `сессия ${host} истекла (HTTP 404), а initialize агента не было`;
    log(`сессия ${host} истекла (HTTP 404) — повторная инициализация`);
    const id = `miksy-bridge-renew-${++renewals}`;
    let ok = false, version = protocol;
    const r = await send({ jsonrpc: "2.0", id, method: "initialize", params: initParams }, (m) => {
      if (m?.id !== id) return out(m);
      ok = m?.result !== undefined;
      if (m?.result?.protocolVersion) version = m.result.protocolVersion;
    }, {});
    if (r.kind !== "answer" || !ok) return `сессия ${host} истекла (HTTP 404), повторная инициализация не удалась${r.kind === "error" ? `: ${r.message}` : ""}`;
    const n = await send({ jsonrpc: "2.0", method: "notifications/initialized" }, out, { session: r.session, protocol: version });
    if (n.kind === "error") return `повторная инициализация ${host}: ${n.message}`;
    session = r.session;
    protocol = version;
    return null;
  })();
  renewing = { stale, done };
  done.then((why) => {
    renewing = null;
    failed = why ? { stale, at: Date.now(), why } : null;
  });
  return done;
}

async function forward(msg: any) {
  const id = msg?.method !== undefined ? msg?.id : undefined;
  try {
    if (msg?.method === "initialize") initParams = msg.params;
    // Идёт восстановление сессии — запрос ждёт его (иначе ушёл бы со старой сессией или до initialized)
    else if (renewing) await renewing.done;
    const deliver = (m: any) => {
      if (msg?.method === "initialize" && m?.id === msg.id && m?.result?.protocolVersion) protocol = m.result.protocolVersion;
      out(m);
    };
    let r = await send(msg, deliver);
    if (r.kind === "gone") {
      const why = await renew(r.stale);
      r = why ? { kind: "error", message: why } : await send(msg, deliver);
      if (r.kind === "gone") r = { kind: "error", message: `HTTP 404 от ${host}: сессия не восстановилась` };
    }
    if (r.kind === "error") error(id, r.message);
  } catch (e) {
    error(id, `внутренняя ошибка: ${text(e)}`);
  }
}

// initialize и notifications/initialized — по порядку, остальное — после них, параллельно (агент
// может вызывать инструменты одновременно). Барьер снимает ответ на initialize, не конец потока
let ready: Promise<void> = Promise.resolve();
const pending = new Set<Promise<void>>();
function handle(line: string) {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const run = ["initialize", "notifications/initialized"].includes(msg?.method) ? (ready = ready.then(() => forward(msg))) : ready.then(() => forward(msg));
  pending.add(run);
  run.finally(() => pending.delete(run));
}

const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
}
if (buf.trim()) handle(buf.trim());
// Агент закрыл stdin: незавершённым запросам — не дольше GRACE, затем отмена и конец сессии
await Promise.race([Promise.allSettled([...pending]), Bun.sleep(GRACE)]);
for (const c of active) c.abort();
if (session)
  await fetch(url, {
    method: "DELETE",
    redirect: "manual",
    headers: { ...headers, "mcp-session-id": session, ...(protocol && { "mcp-protocol-version": protocol }) },
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
process.exit(0);
