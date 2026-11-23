import type { MiksyMap, Layer, MapEntry, McpServer, Os, Resolved, Sourced } from "./types";

const osMatches = (e: { os?: Os | Os[] }, os: Os) => !e.os || [e.os].flat().includes(os);

export function selectGlobal(map: MiksyMap, os: Os): string[] {
  return map.global.filter((e) => osMatches(e, os)).map((e) => e.use);
}

// rel — путь проекта относительно workspace через «/»; "" — сам корень workspace. Без учёта регистра, как слои
// дерева, на всех ОС: ветка корня в machine.yaml другой машины может быть набрана иначе (выпуск 0.2.1, A5)
export function selectProject(map: MiksyMap, rel: string, os: Os): string[] {
  const hit = (e: MapEntry) =>
    e.match !== undefined && (e.match === "**" || (rel !== "" && new Bun.Glob(e.match.toLowerCase()).match(rel.toLowerCase())));
  return map.layers.filter((e) => hit(e) && osMatches(e, os)).map((e) => e.use);
}

// HTTP-сервер без секретов и переменных: определение одно на всех машинах — в файл проекта пишется как есть (штатная
// авторизация агента, например OAuth, сохраняется), в том числе на ОС, для которой он не задан (круг 11b-2)
const fixedHttp = (s: McpServer) => !!s.url && ![s.url, ...Object.values(s.headers ?? {}), ...Object.values(s.env ?? {})].some((v) => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(String(v)));
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sorted(x)]))
  : v;
const sameDef = (a: McpServer, b: McpServer) => JSON.stringify(sorted({ ...a, os: undefined })) === JSON.stringify(sorted({ ...b, os: undefined }));

// Склейка сверху вниз. exclude слоя действует на всё, что пришло из слоёв выше него
export function merge(layers: Layer[], os: Os): Resolved {
  let instructions: Resolved["instructions"] = [];
  const skills = new Map<string, Sourced<Layer["skills"][number]>>();
  const mcp = new Map<string, Sourced<McpServer>>();
  // Только для других ОС (имени нет среди серверов этой ОС) и порядок первого появления имени
  const elsewhere = new Map<string, Sourced<McpServer>>();
  const order = new Map<string, true>();
  const perOs = new Set<string>(); // имена с определением для отдельной ОС: порядок в файле проекта — по первому появлению
  const variants = new Map<string, McpServer[]>(); // все определения имени (с последнего exclude) — одни и те же на любой ОС
  const notes: string[] = [];
  let importSkills: Resolved["importSkills"];
  const skillExcludes: string[] = [];
  const skillSecrets = new Map<string, string>();

  const trust: NonNullable<Resolved["trust"]> = {};

  for (const layer of layers) {
    if (layer.importSkills !== undefined) importSkills = { item: layer.importSkills, layer: layer.name };
    for (const [agent, value] of Object.entries(layer.trust ?? {}))
      trust[agent] = { item: value, layer: layer.name };
    for (const ex of layer.exclude) {
      const [kind, name] = [ex.slice(0, ex.indexOf(".")), ex.slice(ex.indexOf(".") + 1)];
      if (kind === "skill") skillExcludes.push(name);
      const removed =
        kind === "mcp" ? [mcp.delete(name), elsewhere.delete(name), variants.delete(name)].some(Boolean)
        : kind === "skill" ? skills.delete(name)
        : kind === "instructions" ? instructions.length !== (instructions = instructions.filter((i) => i.item.file !== name)).length
        : (() => { throw new Error(`${layer.name}/layer.yaml: непонятный exclude «${ex}» (ожидается mcp.*, skill.*, instructions.*)`); })();
      notes.push(removed ? `${ex} исключён слоем ${layer.name}` : `${layer.name}: exclude ${ex} — исключать нечего`);
    }

    for (const i of layer.instructions) instructions.push({ item: i, layer: layer.name });
    for (const n of layer.skillSecrets ?? []) if (!skillSecrets.has(n)) skillSecrets.set(n, layer.name);

    for (const s of layer.skills) {
      const prev = skills.get(s.name);
      if (prev) notes.push(`skill ${s.name}: ${layer.name} перекрывает ${prev.layer}`);
      skills.set(s.name, { item: s, layer: layer.name });
    }

    for (const s of layer.mcp) {
      order.set(s.name, true);
      variants.set(s.name, [...(variants.get(s.name) ?? []), s]);
      if (s.os) perOs.add(s.name);
      if (s.os && !s.os.includes(os)) {
        notes.push(`mcp ${s.name} (${layer.name}) пропущен: только для ${s.os.join(", ")}`);
        if (!mcp.has(s.name)) elsewhere.set(s.name, { item: s, layer: layer.name });
        continue;
      }
      const prev = mcp.get(s.name);
      if (prev) notes.push(`mcp ${s.name}: ${layer.name} перекрывает ${prev.layer}`);
      mcp.set(s.name, { item: s, layer: layer.name });
      elsewhere.delete(s.name);
    }
  }

  // Имена с os:, которые пишутся как есть на любой ОС: все варианты — HTTP без переменных с одним определением (круг 11b-3)
  const direct = [...perOs].filter((n) => {
    const v = variants.get(n) ?? [];
    return v.length > 0 && v.every((x) => fixedHttp(x) && sameDef(x, v[0]!));
  });
  // Имена с os:, у которых есть и HTTP-, и stdio-вариант: команда miksy mcp без --bridge
  const mixed = [...perOs].filter((n) => new Set((variants.get(n) ?? []).map((x) => !!x.url)).size > 1);

  return {
    layers: layers.map((l) => l.name),
    instructions,
    skills: [...skills.values()],
    mcp: [...mcp.values()],
    ...(elsewhere.size && { elsewhere: [...elsewhere.values()] }),
    ...(perOs.size && { perOs: [...perOs], mcpOrder: [...order.keys()].filter((n) => mcp.has(n) || elsewhere.has(n)) }),
    ...(direct.length && { perOsDirect: direct }),
    ...(mixed.length && { perOsMixed: mixed }),
    ...(importSkills && { importSkills }),
    ...(Object.keys(trust).length && { trust }),
    ...(skillExcludes.length && { skillExcludes }),
    ...(skillSecrets.size && { skillSecrets: [...skillSecrets].map(([item, layer]) => ({ item, layer })) }),
    notes,
  };
}

const BUILTIN = ["HOME", "WORKSPACE"];

export function varRefs(s: McpServer): string[] {
  const text = JSON.stringify([s.command, s.args, s.env, s.url, s.headers, s.agents]);
  return [...new Set([...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))];
}

export type VarSource = "builtin" | "machine" | "secret" | "missing";

export function varSource(name: string, machineVars: Record<string, string>, secrets: Record<string, string>): VarSource {
  if (BUILTIN.includes(name)) return "builtin";
  if (name in machineVars) return "machine";
  if (name in secrets) return "secret";
  return "missing";
}
