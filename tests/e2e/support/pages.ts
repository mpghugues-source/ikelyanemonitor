import { expect, type Page } from "@playwright/test";
import { PASSWORD } from "./db";

/** Sign in through the real login form and wait for the dashboard. */
export async function login(page: Page, email: string, options: { locale?: "en" | "fr"; password?: string; next?: string } = {}) {
  const locale = options.locale ?? "en";
  const next = options.next ? `?next=${encodeURIComponent(options.next)}` : "";
  await page.goto(`/${locale}/login${next}`);
  await page.getByLabel(locale === "fr" ? "Adresse e-mail" : "Email address").fill(email);
  await page.getByLabel(locale === "fr" ? "Mot de passe" : "Password", { exact: true }).fill(options.password ?? PASSWORD);
  await page.getByRole("button", { name: locale === "fr" ? "Se connecter" : "Sign in" }).click();
}

/** Sign in and assert we reached a page that is not the login form. */
export async function loginOk(page: Page, email: string, options: { locale?: "en" | "fr"; password?: string; next?: string } = {}) {
  await login(page, email, options);
  await expect(page).not.toHaveURL(/\/login/);
}

/** The error message of a form (Next.js also renders its own `role="alert"` route announcer). */
export function formError(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

/** Turn off the browser's own constraint checks (minlength, required…) to prove the SERVER validates too. */
export async function skipBrowserValidation(page: Page) {
  await page.evaluate(() => document.querySelectorAll("form").forEach((form) => (form.noValidate = true)));
}
