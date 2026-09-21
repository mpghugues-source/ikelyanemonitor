import { Card, CardContent } from "@/components/ui/card";

/** Placeholder body of a module page whose UI is still to be built. */
export function ModulePlaceholder({ description, comingSoon }: { description: string; comingSoon: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">{comingSoon}</span>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
