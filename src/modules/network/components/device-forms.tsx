"use client";

import { Pencil, Power, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { deleteDeviceAction, registerDeviceAction, toggleDeviceAction, updateDeviceAction } from "@/app/actions/devices";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { DEVICE_TYPES } from "@/modules/network/constants";
import type { DeviceRow } from "@/modules/network/devices";

const NAMESPACES = ["networkAdmin.errors", "auth.errors"];

interface PollerOption {
  id: string;
  label: string;
}

function DeviceFields({ device, pollers }: { device?: DeviceRow; pollers: PollerOption[] }) {
  const t = useTranslations();
  const [snmpVersion, setSnmpVersion] = useState(device?.snmpVersion ?? "V2C");
  const [securityLevel, setSecurityLevel] = useState(device?.snmpV3SecurityLevel ?? "AUTH_PRIV");

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="name">{t("common.name")}</Label>
        <Input id="name" name="name" required maxLength={120} defaultValue={device?.name} placeholder="core-switch-01" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="ipAddress">{t("host.ipAddress")}</Label>
        <Input id="ipAddress" name="ipAddress" required maxLength={45} defaultValue={device?.ipAddress} placeholder="10.0.0.1" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="type">{t("common.type")}</Label>
        <NativeSelect id="type" name="type" defaultValue={device?.type ?? "SWITCH"}>
          {DEVICE_TYPES.map((type) => (
            <option key={type} value={type}>{t(`network.deviceType.${type.toLowerCase()}`)}</option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="pollerHostId">{t("network.poller")}</Label>
        <NativeSelect id="pollerHostId" name="pollerHostId" defaultValue={device?.pollerHostId ?? ""}>
          <option value="">{t("common.none")}</option>
          {pollers.map((poller) => (
            <option key={poller.id} value={poller.id}>{poller.label}</option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="pollIntervalSec">{t("network.pollInterval")} (s)</Label>
        <Input id="pollIntervalSec" name="pollIntervalSec" type="number" min={10} max={86400} required defaultValue={device?.pollIntervalSec ?? 60} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="tags">{t("common.tags")}</Label>
        <Input id="tags" name="tags" defaultValue={device?.tags.join(", ")} placeholder="core, datacenter-1" />
      </div>

      <div className="space-y-2 border-t pt-4 sm:col-span-2">
        <p className="text-sm font-semibold">{t("network.snmp.title")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="snmpVersion">{t("network.snmp.version")}</Label>
        <NativeSelect id="snmpVersion" name="snmpVersion" value={snmpVersion} onChange={(event) => setSnmpVersion(event.target.value as typeof snmpVersion)}>
          <option value="V1">SNMPv1</option>
          <option value="V2C">SNMPv2c</option>
          <option value="V3">SNMPv3</option>
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="snmpPort">{t("network.snmp.port")}</Label>
        <Input id="snmpPort" name="snmpPort" type="number" min={1} max={65535} required defaultValue={device?.snmpPort ?? 161} />
      </div>

      {snmpVersion === "V3" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="snmpV3Username">{t("network.snmp.username")}</Label>
            <Input id="snmpV3Username" name="snmpV3Username" maxLength={255} defaultValue={device?.snmpV3Username ?? ""} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="snmpV3SecurityLevel">{t("network.snmp.securityLevel")}</Label>
            <NativeSelect
              id="snmpV3SecurityLevel"
              name="snmpV3SecurityLevel"
              value={securityLevel}
              onChange={(event) => setSecurityLevel(event.target.value as typeof securityLevel)}
            >
              <option value="NO_AUTH_NO_PRIV">{t("network.snmp.level.noAuthNoPriv")}</option>
              <option value="AUTH_NO_PRIV">{t("network.snmp.level.authNoPriv")}</option>
              <option value="AUTH_PRIV">{t("network.snmp.level.authPriv")}</option>
            </NativeSelect>
          </div>
          {securityLevel !== "NO_AUTH_NO_PRIV" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="snmpV3AuthProtocol">{t("network.snmp.authProtocol")}</Label>
                <NativeSelect id="snmpV3AuthProtocol" name="snmpV3AuthProtocol" defaultValue="SHA">
                  {["MD5", "SHA", "SHA224", "SHA256", "SHA384", "SHA512"].map((protocol) => (
                    <option key={protocol} value={protocol}>{protocol}</option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="snmpV3AuthKey">{t("network.snmp.authProtocol")} — {t("network.snmp.community")}</Label>
                <Input id="snmpV3AuthKey" name="snmpV3AuthKey" type="password" maxLength={255} placeholder={device ? "••••••••" : undefined} />
              </div>
            </>
          ) : null}
          {securityLevel === "AUTH_PRIV" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="snmpV3PrivProtocol">{t("network.snmp.privProtocol")}</Label>
                <NativeSelect id="snmpV3PrivProtocol" name="snmpV3PrivProtocol" defaultValue="AES">
                  {["DES", "AES", "AES192", "AES256"].map((protocol) => (
                    <option key={protocol} value={protocol}>{protocol}</option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="snmpV3PrivKey">{t("network.snmp.privProtocol")} — {t("network.snmp.community")}</Label>
                <Input id="snmpV3PrivKey" name="snmpV3PrivKey" type="password" maxLength={255} placeholder={device ? "••••••••" : undefined} />
              </div>
            </>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="snmpV3ContextName">{t("network.snmp.contextName")}</Label>
            <Input id="snmpV3ContextName" name="snmpV3ContextName" maxLength={255} />
          </div>
        </>
      ) : (
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="snmpCommunity">{t("network.snmp.community")}</Label>
          <Input id="snmpCommunity" name="snmpCommunity" type="password" maxLength={255} placeholder={device?.hasSecret ? "••••••••" : "public"} />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="snmpTimeoutMs">{t("network.snmp.timeout")} (ms)</Label>
        <Input id="snmpTimeoutMs" name="snmpTimeoutMs" type="number" min={100} max={60000} required defaultValue={device?.snmpTimeoutMs ?? 3000} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="snmpRetries">{t("network.snmp.retries")}</Label>
        <Input id="snmpRetries" name="snmpRetries" type="number" min={0} max={10} required defaultValue={device?.snmpRetries ?? 1} />
      </div>
    </div>
  );
}

export function RegisterDeviceForm({ pollers }: { pollers: PollerOption[] }) {
  const t = useTranslations("networkAdmin");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button>{t("register")}</Button>} />
      <DialogContent className="sm:max-w-lg">
        <ActionForm
          action={async (previous, formData) => {
            const result = await registerDeviceAction(previous, formData);
            if (result.status === "success") setOpen(false);
            return result;
          }}
          namespaces={NAMESPACES}
          className="space-y-4"
        >
          {({ pending }) => (
            <>
              <DialogHeader>
                <DialogTitle>{t("registerTitle")}</DialogTitle>
                <DialogDescription>{t("registerHelp")}</DialogDescription>
              </DialogHeader>
              <DeviceFields pollers={pollers} />
              <DialogFooter>
                <Button type="submit" disabled={pending}>{pending ? t("registering") : t("register")}</Button>
              </DialogFooter>
            </>
          )}
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function EditDeviceDialog({ device, pollers }: { device: DeviceRow; pollers: PollerOption[] }) {
  const t = useTranslations("networkAdmin");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={tc("edit")}><Pencil className="size-4" aria-hidden /></Button>} />
      <DialogContent className="sm:max-w-lg">
        <ActionForm
          action={async (previous, formData) => {
            const result = await updateDeviceAction(previous, formData);
            if (result.status === "success") setOpen(false);
            return result;
          }}
          namespaces={NAMESPACES}
          className="space-y-4"
        >
          {({ pending }) => (
            <>
              <DialogHeader>
                <DialogTitle>{t("editTitle")}</DialogTitle>
                <DialogDescription>{t("editSecretHelp")}</DialogDescription>
              </DialogHeader>
              <input type="hidden" name="id" value={device.id} />
              <DeviceFields device={device} pollers={pollers} />
              <DialogFooter>
                <Button type="submit" disabled={pending}>{pending ? tc("loading") : tc("save")}</Button>
              </DialogFooter>
            </>
          )}
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function DeviceActions({ device, pollers }: { device: DeviceRow; pollers: PollerOption[] }) {
  const t = useTranslations("networkAdmin");
  const tc = useTranslations("common");
  return (
    <div className="flex items-center justify-end gap-1">
      <EditDeviceDialog device={device} pollers={pollers} />
      <ActionForm action={toggleDeviceAction} namespaces={NAMESPACES}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={device.id} />
            <input type="hidden" name="enabled" value={String(!device.enabled)} />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={device.enabled ? t("actions.disable") : t("actions.enable")}>
              <Power className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </ActionForm>
      <ActionForm action={deleteDeviceAction} namespaces={NAMESPACES} confirm={t("actions.deleteConfirm", { name: device.name })}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={device.id} />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={tc("delete")}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </ActionForm>
    </div>
  );
}
