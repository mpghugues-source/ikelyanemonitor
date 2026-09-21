import { createNavigation } from "next-intl/navigation";
import { routing } from "@/i18n/routing";

/** Locale-aware replacements for next/link and next/navigation: always use these in the UI. */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
