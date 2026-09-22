import { Network } from "lucide-react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireActor } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/prisma";
import { DeviceActions, RegisterDeviceForm } from "@/modules/network/components/device-forms";
import { listDevices } from "@/modules/network/devices";
import { listHosts } from "@/modules/servers/hosts";

export default async function NetworkPage({ params }: PageProps<"/[locale]/network">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("devices:read");
  const t = await getTranslations();
  const format = await getFormatter();
  const db = getPrisma();

  const devices = await listDevices(db, actor);
  if (!devices.ok) return null;

  const canWrite = can(actor.role, "devices:write");
  const hosts = canWrite ? await listHosts(db, actor) : null;
  const pollers = hosts?.ok ? hosts.value.map((host) => ({ id: host.id, label: host.displayName ?? host.hostname })) : [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader icon={Network} title={t("network.title")} subtitle={t("network.subtitle")} />
        {canWrite ? <RegisterDeviceForm pollers={pollers} /> : null}
      </div>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {devices.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("networkAdmin.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("network.device")}</TableHead>
                  <TableHead>{t("common.type")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead>{t("network.poller")}</TableHead>
                  <TableHead>{t("hostAdmin.lastSeen")}</TableHead>
                  {canWrite ? <TableHead className="text-right">{t("common.actions")}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.value.map((device) => (
                  <TableRow key={device.id} data-testid={`device-${device.name}`}>
                    <TableCell>
                      <div className="font-medium">{device.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{device.ipAddress}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t(`network.deviceType.${device.type.toLowerCase()}`)}</TableCell>
                    <TableCell className="space-x-1">
                      <Badge variant={device.status === "UP" ? "default" : "secondary"}>{t(`status.${device.status.toLowerCase()}`)}</Badge>
                      {!device.enabled ? <Badge variant="destructive">{t("common.disabled")}</Badge> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{device.pollerHostname ?? t("common.none")}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {device.lastPolledAt ? format.dateTime(device.lastPolledAt, { dateStyle: "short", timeStyle: "short" }) : t("hostAdmin.neverSeen")}
                    </TableCell>
                    {canWrite ? (
                      <TableCell className="text-right">
                        <DeviceActions device={device} pollers={pollers} />
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
