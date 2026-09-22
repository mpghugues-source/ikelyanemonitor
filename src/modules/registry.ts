import { AlertTriangle, Bell, Database, Globe, Leaf, Network, Server, Workflow, type LucideIcon } from "lucide-react";

/**
 * The monitoring modules shown in navigation and on the overview page.
 *
 * Code layout: each module owns its domain logic under src/modules/<key>/ (ingestion, pure
 * analysis helpers) and its pages under src/app/[locale]/(dashboard)/<key>/.
 *
 * Labels are NOT stored here: they come from the dictionaries (`nav.<key>` for the name,
 * `modules.<key>` for the description), so adding a language never touches this file.
 */
export type ModuleKey = "servers" | "databases" | "network" | "saas" | "topology" | "finops" | "incidents" | "alerts";

export interface ModuleDefinition {
  key: ModuleKey;
  /** Path without the locale prefix. */
  href: `/${ModuleKey}`;
  icon: LucideIcon;
}

export const MODULES: readonly ModuleDefinition[] = [
  { key: "servers", href: "/servers", icon: Server },
  { key: "databases", href: "/databases", icon: Database },
  { key: "network", href: "/network", icon: Network },
  { key: "saas", href: "/saas", icon: Globe },
  { key: "topology", href: "/topology", icon: Workflow },
  { key: "finops", href: "/finops", icon: Leaf },
  { key: "incidents", href: "/incidents", icon: AlertTriangle },
  { key: "alerts", href: "/alerts", icon: Bell },
];
