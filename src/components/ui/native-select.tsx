import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** A plain <select> styled like the shadcn inputs (accessible, works without JavaScript). */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-colors",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
