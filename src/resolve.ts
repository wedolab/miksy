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

// Склейка сверху вниз. exclude слоя действует на всё, что пришло из слоёв выше него
export function merge(layers: Layer[], os: Os): Resolved {
  let instructions: Resolved["instructions"] = [];
  const skills = new Map<string, Sourced<Layer["skills"][number]>>();
  const mcp = new Map<string, Sourced<McpServer>>();
  const notes: string[] = [];
  let importSkills: Resolved["importSkills"];
  const skillExcludes: string[] = [];

  const trust: NonNullable<Resolved["trust"]> = {};

  for (const layer of layers) {
    if (layer.importSkills !== undefined) importSkills = { item: layer.importSkills, layer: layer.name };
    for (const [agent, value] of Object.entries(layer.trust ?? {}) as ["codex" | "claude", boolean][])
      trust[agent] = { item: value, layer: layer.name };
    for (const ex of layer.exclude) {
      const [kind, name] = [ex.slice(0, ex.indexOf(".")), ex.slice(ex.indexOf(".") + 1)];
      if (kind === "skill") skillExcludes.push(name);
      const removed =
        kind === "mcp" ? mcp.delete(name)
        : kind === "skill" ? skills.delete(name)
        : kind === "instructions" ? instructions.length !== (instructions = instructions.filter((i) => i.item.file !== name)).length
        : (() => { throw new Error(`${layer.name}/layer.yaml: непонятный exclude «${ex}» (ожидается mcp.*, skill.*, instructions.*)`); })();
      notes.push(removed ? `${ex} исключён слоем ${layer.name}` : `${layer.name}: exclude ${ex} — исключать нечего`);
    }

    for (const i of layer.instructions) instructions.push({ item: i, layer: layer.name });

    for (const s of layer.skills) {
      const prev = skills.get(s.name);
      if (prev) notes.push(`skill ${s.name}: ${layer.name} перекрывает ${prev.layer}`);
      skills.set(s.name, { item: s, layer: layer.name });
    }

    for (const s of layer.mcp) {
      if (s.os && !s.os.includes(os)) {
        notes.push(`mcp ${s.name} (${layer.name}) пропущен: только для ${s.os.join(", ")}`);
        continue;
      }
      const prev = mcp.get(s.name);
      if (prev) notes.push(`mcp ${s.name}: ${layer.name} перекрывает ${prev.layer}`);
      mcp.set(s.name, { item: s, layer: layer.name });
    }
  }

  return {
    layers: layers.map((l) => l.name),
    instructions,
    skills: [...skills.values()],
    mcp: [...mcp.values()],
    ...(importSkills && { importSkills }),
    ...(Object.keys(trust).length && { trust }),
    ...(skillExcludes.length && { skillExcludes }),
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
