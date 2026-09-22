"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { createDependencyAction, createNodeAction } from "@/app/actions/topology";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { TopologyNodeRow } from "@/modules/topology/service";

const NAMESPACES = ["topologyAdmin.errors", "auth.errors"];

export interface EntityOption {
  id: string;
  name: string;
}

const ENTITY_KINDS = ["HOST", "NETWORK_DEVICE", "DATABASE", "ENDPOINT"] as const;
type EntityKind = (typeof ENTITY_KINDS)[number];
const LOGICAL_KINDS = ["SERVICE", "EXTERNAL"] as const;
const NODE_KIND_LABEL_KEY: Record<EntityKind | (typeof LOGICAL_KINDS)[number], string> = {
  HOST: "host",
  NETWORK_DEVICE: "networkDevice",
  DATABASE: "database",
  ENDPOINT: "endpoint",
  SERVICE: "service",
  EXTERNAL: "external",
};

const DEPENDENCY_KINDS = [
  { value: "DEPENDS_ON", labelKey: "dependsOn" },
  { value: "HOSTED_ON", labelKey: "hostedOn" },
  { value: "CONNECTED_TO", labelKey: "connectedTo" },
  { value: "ROUTES_TO", labelKey: "routesTo" },
  { value: "REPLICATES_TO", labelKey: "replicatesTo" },
] as const;

const CRITICALITY_LEVELS = [
  { value: "INFO", labelKey: "info" },
  { value: "WARNING", labelKey: "warning" },
  { value: "CRITICAL", labelKey: "critical" },
] as const;

export function AddNodeDialog({ entities }: { entities: Record<EntityKind, EntityOption[]> }) {
  const t = useTranslations("topology");
  const ta = useTranslations("topologyAdmin");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>("SERVICE");
  const [label, setLabel] = useState("");
  const isEntity = (ENTITY_KINDS as readonly string[]).includes(kind);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) { setKind("SERVICE"); setLabel(""); }
      }}
    >
      <DialogTrigger render={<Button variant="outline">{t("addNode")}</Button>} />
      <DialogContent className="sm:max-w-sm">
        <ActionForm
          action={async (previous, formData) => {
            const result = await createNodeAction(previous, formData);
            if (result.status === "success") setOpen(false);
            return result;
          }}
          namespaces={NAMESPACES}
          className="space-y-4"
        >
          {({ pending }) => (
            <>
              <DialogHeader>
                <DialogTitle>{t("addNode")}</DialogTitle>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="kind">{tc("type")}</Label>
                <NativeSelect id="kind" name="kind" value={kind} onChange={(event) => { setKind(event.target.value); setLabel(""); }}>
                  {[...ENTITY_KINDS, ...LOGICAL_KINDS].map((k) => (
                    <option key={k} value={k}>{t(`nodeKind.${NODE_KIND_LABEL_KEY[k]}`)}</option>
                  ))}
                </NativeSelect>
              </div>
              {isEntity ? (
                <div className="space-y-2">
                  <Label htmlFor="refId">{tc("name")}</Label>
                  <NativeSelect
                    id="refId"
                    name="refId"
                    required
                    defaultValue=""
                    onChange={(event) => setLabel(event.target.options[event.target.selectedIndex]?.text ?? "")}
                  >
                    <option value="" disabled>{ta("choose")}</option>
                    {entities[kind as EntityKind].map((entity) => (
                      <option key={entity.id} value={entity.id}>{entity.name}</option>
                    ))}
                  </NativeSelect>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="label">{tc("name")}</Label>
                  <Input id="label" name="label" required maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} />
                </div>
              )}
              {isEntity ? <input type="hidden" name="label" value={label} /> : null}
              <DialogFooter>
                <Button type="submit" disabled={pending || !label}>{tc("create")}</Button>
              </DialogFooter>
            </>
          )}
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function AddDependencyDialog({ nodes }: { nodes: TopologyNodeRow[] }) {
  const t = useTranslations("topology");
  const ta = useTranslations("topologyAdmin");
  const tc = useTranslations("common");
  const ts = useTranslations("severity");
  const [open, setOpen] = useState(false);

  if (nodes.length < 2) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline">{t("addDependency")}</Button>} />
      <DialogContent className="sm:max-w-sm">
        <ActionForm
          action={async (previous, formData) => {
            const result = await createDependencyAction(previous, formData);
            if (result.status === "success") setOpen(false);
            return result;
          }}
          namespaces={NAMESPACES}
          className="space-y-4"
        >
          {({ pending }) => (
            <>
              <DialogHeader>
                <DialogTitle>{t("addDependency")}</DialogTitle>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="parentNodeId">{t("parent")}</Label>
                <NativeSelect id="parentNodeId" name="parentNodeId" required defaultValue="">
                  <option value="" disabled>{ta("choose")}</option>
                  {nodes.map((n) => (<option key={n.id} value={n.id}>{n.label}</option>))}
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="childNodeId">{t("child")}</Label>
                <NativeSelect id="childNodeId" name="childNodeId" required defaultValue="">
                  <option value="" disabled>{ta("choose")}</option>
                  {nodes.map((n) => (<option key={n.id} value={n.id}>{n.label}</option>))}
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="kind">{tc("type")}</Label>
                <NativeSelect id="kind" name="kind" defaultValue="DEPENDS_ON">
                  {DEPENDENCY_KINDS.map(({ value, labelKey }) => (
                    <option key={value} value={value}>{t(`dependencyKind.${labelKey}`)}</option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="criticality">{t("criticality")}</Label>
                <NativeSelect id="criticality" name="criticality" defaultValue="WARNING">
                  {CRITICALITY_LEVELS.map(({ value, labelKey }) => (
                    <option key={value} value={value}>{ts(labelKey)}</option>
                  ))}
                </NativeSelect>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={pending}>{tc("create")}</Button>
              </DialogFooter>
            </>
          )}
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
