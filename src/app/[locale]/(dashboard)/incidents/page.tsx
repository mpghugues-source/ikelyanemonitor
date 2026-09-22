import { AlertTriangle } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { requireActor } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/prisma";
import { IncidentCard } from "@/modules/incidents/components/incident-list";
import { listActiveIncidents, listResolvedIncidents } from "@/modules/incidents/service";

export default async function IncidentsPage({ params }: PageProps<"/[locale]/incidents">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("incidents:read");
  const t = await getTranslations();
  const db = getPrisma();
  const now = new Date();

  const [active, resolved] = await Promise.all([listActiveIncidents(db, actor), listResolvedIncidents(db, actor)]);
  if (!active.ok || !resolved.ok) return null;

  const canAct = can(actor.role, "incidents:acknowledge");

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader icon={AlertTriangle} title={t("incidents.title")} subtitle={t("incidents.subtitle")} />

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{t("incidentsAdmin.active")}</h2>
        {active.value.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("incidentsAdmin.empty")}</p>
        ) : (
          <div className="space-y-4">
            {active.value.map((incident) => (
              <IncidentCard key={incident.id} incident={incident} canAct={canAct} now={now} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{t("incidentsAdmin.resolvedRecent")}</h2>
        {resolved.value.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("incidentsAdmin.emptyResolved")}</p>
        ) : (
          <div className="space-y-4">
            {resolved.value.map((incident) => (
              <IncidentCard key={incident.id} incident={incident} canAct={canAct} now={now} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
