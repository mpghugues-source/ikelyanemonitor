import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import fr from "../messages/fr.json";

type Tree = { [key: string]: string | Tree };

/** Flatten a nested dictionary to { "a.b.c": "text" }. */
function flatten(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

/** ICU argument names used by a message: "{count, plural, …}" -> "count", "{time}" -> "time".
 *  A name is an identifier directly followed by "," or "}" right after an opening brace; the
 *  free text inside plural branches ("{# days}") never matches, so only real arguments count. */
function icuArguments(message: string): string[] {
  const names = new Set<string>();
  for (const m of message.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g)) names.add(m[1]);
  return [...names].sort();
}

const flatEn = flatten(en as Tree);
const flatFr = flatten(fr as Tree);

describe("i18n dictionaries", () => {
  it("expose exactly the same keys in English and French", () => {
    const onlyEn = Object.keys(flatEn).filter((k) => !(k in flatFr));
    const onlyFr = Object.keys(flatFr).filter((k) => !(k in flatEn));
    expect({ missingInFrench: onlyEn, missingInEnglish: onlyFr }).toEqual({
      missingInFrench: [],
      missingInEnglish: [],
    });
  });

  it("never contain an empty message", () => {
    const empty = [...Object.entries(flatEn), ...Object.entries(flatFr)]
      .filter(([, v]) => v.trim() === "")
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("use the same ICU arguments in both languages", () => {
    const mismatches = Object.keys(flatEn)
      .filter((k) => k in flatFr)
      .filter((k) => JSON.stringify(icuArguments(flatEn[k])) !== JSON.stringify(icuArguments(flatFr[k])))
      .map((k) => `${k}: en=${icuArguments(flatEn[k])} fr=${icuArguments(flatFr[k])}`);
    expect(mismatches).toEqual([]);
  });

  it("cover the domains required by the product brief", () => {
    // System statuses, host metrics, network port terms, database metrics, FinOps/GreenOps.
    const required = [
      "status.up",
      "status.down",
      "status.degraded",
      "host.cpuUsage",
      "host.memoryUsage",
      "host.diskUsage",
      "host.iops",
      "network.bandwidthIn",
      "network.bandwidthOut",
      "network.packetLoss",
      "network.errors",
      "network.crcErrors",
      "database.cacheHitRatio",
      "database.slowQueries",
      "database.deadlocks",
      "finops.wastedSpend",
      "finops.carbonFootprint",
      "finops.co2e",
      "finops.energyKwh",
    ];
    for (const key of required) {
      expect(flatEn[key], `en.${key}`).toBeTruthy();
      expect(flatFr[key], `fr.${key}`).toBeTruthy();
    }
  });
});
