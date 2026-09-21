import type { LucideIcon } from "lucide-react";

export function PageHeader({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle?: string }) {
  return (
    <header className="mb-6 flex items-start gap-3">
      <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
        <Icon className="size-5" aria-hidden />
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
    </header>
  );
}
