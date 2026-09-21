import { getTranslations, setRequestLocale } from "next-intl/server";
import { logoutAction } from "@/app/actions/session";
import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { Button, buttonVariants } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getSession } from "@/lib/auth/dal";
import { previewInvitation } from "@/lib/auth/invitations";
import { getPrisma } from "@/lib/prisma";

/**
 * Landing page of an invitation link. The token is a bearer secret: it is only ever compared by
 * hash, and an unknown/used/expired token shows one generic message that does not say which.
 */
export default async function InvitePage({ params }: PageProps<"/[locale]/invite/[token]">) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();

  const invitation = await previewInvitation(getPrisma(), token);
  if (!invitation) {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm font-medium text-destructive">{t("auth.invite.invalid")}</p>
        <Link href="/login" className="text-sm font-medium text-primary underline underline-offset-4">
          {t("auth.login.submit")}
        </Link>
      </div>
    );
  }

  const session = await getSession();
  const role = t(`roles.${invitation.role.toLowerCase()}`);

  let body: React.ReactNode;
  if (!invitation.accountExists) {
    body = <AcceptInviteForm token={token} mode="new" email={invitation.email} />;
  } else if (session?.user.email === invitation.email) {
    body = <AcceptInviteForm token={token} mode="existing" email={invitation.email} />;
  } else if (session) {
    body = (
      <div className="space-y-3">
        <p role="alert" className="text-sm">{t("auth.invite.wrongAccount", { current: session.user.email, email: invitation.email })}</p>
        <form action={logoutAction}>
          <Button type="submit" variant="outline">{t("auth.logout")}</Button>
        </form>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-sm">{t("auth.invite.existingAccount", { email: invitation.email })}</p>
        <Link href={{ pathname: "/login", query: { next: `/invite/${token}` } }} className={buttonVariants()}>
          {t("auth.invite.signIn")}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("auth.invite.title", { org: invitation.orgName })}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("auth.invite.subtitle", { role })}</p>
      </div>
      {body}
    </div>
  );
}
