import { defineRouting } from "next-intl/routing";

/**
 * Supported UI languages. Locale codes are the URL prefixes (/en/…, /fr/…) and the names of the
 * dictionaries in messages/. They match the Prisma `Locale` enum (EN | FR) case-insensitively —
 * see `toPrismaLocale` — so a user's stored preference can drive the redirect.
 */
export const routing = defineRouting({
  locales: ["en", "fr"],
  defaultLocale: "en",
  // Always show the prefix: /en and /fr are distinct, shareable, cacheable URLs.
  localePrefix: "always",
});

export type AppLocale = (typeof routing.locales)[number];

export function toPrismaLocale(locale: AppLocale): "EN" | "FR" {
  return locale === "fr" ? "FR" : "EN";
}
