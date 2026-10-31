import { varRefs, varSource } from "./resolve";
import type { Machine, Resolved } from "./types";

const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));

export function formatResolved(
  title: [string, string][],
  r: Resolved,
  machine: Machine,
  secrets: Record<string, string>,
): string {
  const out: string[] = [];
  const problems: string[] = [];
  const width = Math.max(...title.map(([k]) => k.length)) + 2;
  for (const [k, v] of title) out.push(pad(k, width) + v);
  out.push(pad("Слои", width) + (r.layers.join(" → ") || "—"), "");

  out.push("Инструкции");
  if (!r.instructions.length) out.push("  —");
  for (const i of r.instructions) out.push("  " + pad(i.layer, 14) + i.item.file);
  out.push("");

  out.push("MCP");
  if (!r.mcp.length) out.push("  —");
  const nameW = Math.max(0, ...r.mcp.map((m) => m.item.name.length)) + 2;
  for (const { item, layer } of r.mcp) {
    const vars = varRefs(item).map((v) => {
      const src = varSource(v, machine.vars, secrets);
      if (src === "missing") problems.push(`mcp ${item.name}: переменная ${v} не задана ни в local/machine.yaml, ни в local/secrets.env`);
      return src === "builtin" ? null : `${v} ${src === "missing" ? "НЕТ" : src === "secret" ? "(секрет)" : "(машина)"}`;
    }).filter(Boolean);
    const kind = item.url ? "http" : "stdio";
    const special = Object.entries(item.agents ?? {}).map(([a, v]) => (v === "skip" ? `${a}: skip` : `${a}: raw`));
    out.push("  " + pad(item.name, nameW) + pad(layer, 12) + pad(kind, 7) + [...vars, ...special].join(", "));
  }
  out.push("");

  out.push("Skills");
  if (!r.skills.length) out.push("  —");
  for (const s of r.skills) out.push("  " + pad(s.item.name, 24) + s.layer);

  if (r.notes.length) out.push("", "Заметки", ...r.notes.map((n) => "  " + n));
  if (problems.length) out.push("", "Проблемы", ...problems.map((p) => "  " + p));
  return out.join("\n");
}
