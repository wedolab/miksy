import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Machine } from "./types";
import { emptyState, sha, type Manifest } from "./manifest";
import { pathKey } from "./paths";
import { definitionHash, parseToml, splitToml } from "./toml";
import { backup } from "./backup";
import { protectedBy } from "./git";
import { guard } from "./bounds";
import { ensurePrivateLocal } from "./secretfiles";

// adopt передаёт только выбранное имя, сам общий файл не переписывает.
export function adoptCodexTable(manifest: Manifest, machine: Machine, name: string, expected: unknown, dryRun = false) {
  const file = join(machine.home, ".codex/config.toml");
  guard(file, machine.home);
  if (protectedBy(file)) throw new Error("Codex config отслеживается git — таблица не может перейти во владение miksy");
  const text = readFileSync(file, "utf8"), doc = parseToml(text), parts = splitToml(text);
  if (!doc.mcp_servers?.[name] || definitionHash(doc.mcp_servers[name]) !== definitionHash(expected))
    throw new Error("Codex: исходная таблица изменилась после чтения — повторите adopt");
  const prev = manifest.targets["codex|global"] ?? emptyState();
  const old = prev.toml?.[pathKey(file)];
  if (old && !old.definitions && sha(parts.block) !== old.hash) throw new Error("Codex: прежний блок изменён — сначала восстановите его по бэкапу, затем повторите adopt");
  if (dryRun) return;
  ensurePrivateLocal();
  backup(file);
  const definitions = old?.definitions ?? Object.fromEntries((old?.names ?? []).map((n) => [n, definitionHash(parts.servers[n])]));
  (prev.toml ??= {})[pathKey(file)] = { hash: sha(parts.block), names: [...new Set([...(old?.names ?? []), name])],
    definitions: { ...definitions, [name]: definitionHash(doc.mcp_servers[name]) } };
  manifest.targets["codex|global"] = prev;
}
