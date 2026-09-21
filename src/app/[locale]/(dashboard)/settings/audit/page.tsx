import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listAuditLog } from "@/lib/auth/audit";
import { requireActor } from "@/lib/auth/dal";
import { getPrisma } from "@/lib/prisma";

/** Human summary of an event's non-sensitive metadata (only whitelisted keys are ever shown). */
function summarize(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  const m = metadata as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["email", "hostname", "role"] as const) if (typeof m[key] === "string") parts.push(m[key] as string);
  if (typeof m.from === "string" && typeof m.to === "string") parts.push(`${m.from} → ${m.to}`);
  return parts.join(" · ");
}

export default async function AuditPage({ params }: PageProps<"/[locale]/settings/audit">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("audit:read");
  const t = await getTranslations("audit");
  const format = await getFormatter();

  const result = await listAuditLog(getPrisma(), actor);
  if (!result.ok) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {result.value.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("time")}</TableHead>
                <TableHead>{t("actor")}</TableHead>
                <TableHead>{t("action")}</TableHead>
                <TableHead>{t("target")}</TableHead>
                <TableHead>{t("address")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.value.map((row) => {
                const key = `actions.${row.action.replace(/\./g, "_")}`;
                return (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{format.dateTime(row.createdAt, { dateStyle: "short", timeStyle: "medium" })}</TableCell>
                    <TableCell>{row.actorEmail ?? t("system")}</TableCell>
                    <TableCell className="font-medium">{t.has(key) ? t(key) : row.action}</TableCell>
                    <TableCell className="text-muted-foreground">{summarize(row.metadata)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.ipAddress ?? "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
