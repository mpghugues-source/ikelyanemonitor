import { expect, test } from "@playwright/test";
import { addMember, cleanup, makeOrg, makeUser, query, setMemberRole, type Role, type TestOrg } from "./support/db";
import { formError, loginOk } from "./support/pages";

test.describe("what each role can see and do", () => {
  let org: TestOrg;
  test.beforeAll(async () => {
    org = await makeOrg("rbac");
  });
  test.afterAll(cleanup);

  const roles = [
    { role: "viewer", register: false, audit: false, invite: false },
    { role: "operator", register: false, audit: false, invite: false },
    { role: "admin", register: true, audit: true, invite: true },
    { role: "owner", register: true, audit: true, invite: true },
  ] as const;

  for (const expected of roles) {
    test(`${expected.role}: menus, forms and pages match the permission matrix`, async ({ page }) => {
      await loginOk(page, org[expected.role].email);

      // The header shows who is signed in and with which role.
      await expect(page.getByText(org.name).first()).toBeVisible();

      // Servers: the registration form exists only for roles allowed to write.
      await page.goto("/en/servers");
      await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();
      await expect(page.getByLabel("Hostname")).toHaveCount(expected.register ? 1 : 0);

      // Audit log: visible tab and reachable page only for administrators.
      await page.goto("/en/settings/members");
      await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(expected.audit ? 1 : 0);
      await expect(page.getByRole("button", { name: "Create invitation" })).toHaveCount(expected.invite ? 1 : 0);

      await page.goto("/en/settings/audit");
      if (expected.audit) {
        await expect(page.getByText("Security-relevant events in this organization")).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
        await expect(page.getByRole("table")).toHaveCount(0); // nothing of the log leaks into the page
      }
    });
  }

  test("an administrator can only offer the roles they are allowed to grant; an owner can offer them all", async ({ page }) => {
    await loginOk(page, org.admin.email);
    await page.goto("/en/settings/members");
    const adminOptions = await page.locator("#invite-role option").allTextContents();
    expect(adminOptions).toEqual(expect.arrayContaining(["Operator", "Viewer"]));
    expect(adminOptions).not.toContain("Owner");
    expect(adminOptions).not.toContain("Administrator");
  });

  test("an administrator cannot change or remove the owner or another administrator (no controls at all)", async ({ page }) => {
    await loginOk(page, org.admin.email);
    await page.goto("/en/settings/members");
    const ownerRow = page.getByRole("row").filter({ hasText: org.owner.email });
    await expect(ownerRow).toBeVisible();
    await expect(ownerRow.getByRole("combobox")).toHaveCount(0);
    await expect(ownerRow.getByRole("button")).toHaveCount(0);

    // Their own row only offers "Leave", never a role selector.
    const selfRow = page.getByRole("row").filter({ hasText: org.admin.email });
    await expect(selfRow.getByRole("combobox")).toHaveCount(0);
    await expect(selfRow.getByRole("button", { name: "Leave organization" })).toBeVisible();

    // Operators and viewers can be managed.
    const operatorRow = page.getByRole("row").filter({ hasText: org.operator.email });
    await expect(operatorRow.getByRole("combobox")).toHaveCount(1);
  });

  test("a viewer sees the member list but has no control on it", async ({ page }) => {
    await loginOk(page, org.viewer.email);
    await page.goto("/en/settings/members");
    await expect(page.getByRole("row").filter({ hasText: org.owner.email })).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByText("Your role cannot invite members.")).toBeVisible();
  });
});

test.describe("stale pages cannot be used to exceed a role that changed meanwhile", () => {
  let org: TestOrg;
  test.beforeAll(async () => {
    org = await makeOrg("stale");
  });
  test.afterAll(cleanup);

  test("an admin demoted to viewer while the servers page is open is refused by the server", async ({ page }) => {
    await loginOk(page, org.admin.email);
    await page.goto("/en/servers");
    await expect(page.getByLabel("Hostname")).toBeVisible(); // the form is on screen…

    await setMemberRole(org.id, org.admin.id, "VIEWER"); // …then someone demotes this user

    await page.getByLabel("Hostname").fill("stale-form-host");
    await page.getByRole("button", { name: "Register server" }).click();
    await expect(formError(page)).toHaveText("Your role does not allow this action.");
    await expect(page.getByTestId("credentials")).toHaveCount(0);

    const hosts = await query(`SELECT 1 FROM monitored_hosts WHERE "orgId" = $1 AND hostname = $2`, [org.id, "stale-form-host"]);
    expect(hosts).toHaveLength(0);
  });

  test("an operator promoted while a page is open gets the new rights only after the server says so (no stale UI trust)", async ({ page }) => {
    await loginOk(page, org.operator.email);
    await page.goto("/en/settings/audit");
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();

    await setMemberRole(org.id, org.operator.id, "ADMIN");
    await page.goto("/en/settings/audit");
    await expect(page.getByText("Security-relevant events in this organization")).toBeVisible();
  });
});

test.describe("member management through the browser", () => {
  let org: TestOrg;
  test.beforeAll(async () => {
    org = await makeOrg("mgmt");
  });
  test.afterAll(cleanup);

  test("an owner changes a role: the change is stored, audited and takes effect for the member at once", async ({ page, browser }) => {
    const memberPage = await (await browser.newContext()).newPage();
    await loginOk(memberPage, org.viewer.email);
    await memberPage.goto("/en/servers");
    await expect(memberPage.getByLabel("Hostname")).toHaveCount(0);

    await loginOk(page, org.owner.email);
    await page.goto("/en/settings/members");
    const row = page.getByRole("row").filter({ hasText: org.viewer.email });
    await row.getByRole("combobox").selectOption("ADMIN");
    await row.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await query<{ role: Role }>(`SELECT role FROM memberships WHERE "userId" = $1`, [org.viewer.id]))[0].role).toBe("ADMIN");

    // The member's already-open session gains the right on its next request, without signing in again.
    await memberPage.goto("/en/servers");
    await expect(memberPage.getByLabel("Hostname")).toHaveCount(1);

    await page.goto("/en/settings/audit");
    await expect(page.getByRole("row").filter({ hasText: "Role changed" }).first()).toBeVisible();
    await memberPage.context().close();
  });

  test("an owner removes a member (after a confirmation); the removed user loses access immediately", async ({ page, browser }) => {
    const target = org.operator;
    const targetPage = await (await browser.newContext()).newPage();
    await loginOk(targetPage, target.email);
    await targetPage.goto("/en/servers");

    await loginOk(page, org.owner.email);
    await page.goto("/en/settings/members");
    const row = page.getByRole("row").filter({ hasText: target.email });

    // Declining the confirmation dialog changes nothing.
    page.once("dialog", (dialog) => dialog.dismiss());
    await row.getByRole("button", { name: "Remove" }).click();
    await expect(row).toBeVisible();
    expect(await query(`SELECT 1 FROM memberships WHERE "userId" = $1`, [target.id])).toHaveLength(1);

    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain(target.name);
      return dialog.accept();
    });
    await row.getByRole("button", { name: "Remove" }).click();
    await expect(row).toHaveCount(0);
    expect(await query(`SELECT 1 FROM memberships WHERE "userId" = $1`, [target.id])).toHaveLength(0);

    await targetPage.goto("/en/servers");
    await expect(targetPage).toHaveURL(/\/en\/no-organization$/);
    await targetPage.context().close();
  });

  test("the last owner cannot leave the organization", async ({ page }) => {
    // org.owner is the only owner of this fresh organization.
    const solo = await makeOrg("solo");
    await loginOk(page, solo.owner.email);
    await page.goto("/en/settings/members");
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("row").filter({ hasText: solo.owner.email }).getByRole("button", { name: "Leave organization" }).click();
    await expect(formError(page)).toHaveText("An organization must keep at least one owner.");
    const still = await query(`SELECT role FROM memberships WHERE "userId" = $1 AND "orgId" = $2`, [solo.owner.id, solo.id]);
    expect(still).toEqual([{ role: "OWNER" }]);
  });

  test("with two owners, one may leave — and the survivor becomes the last owner", async ({ page }) => {
    const pair = await makeOrg("pair");
    const second = await makeUser("pair-second-owner");
    await addMember(pair.id, second, "OWNER");
    await loginOk(page, second.email);
    await page.goto("/en/settings/members");
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Leave organization" }).click();
    await expect(page).toHaveURL(/\/en\/no-organization$/);
    const owners = await query(`SELECT 1 FROM memberships WHERE "orgId" = $1 AND role = 'OWNER'`, [pair.id]);
    expect(owners).toHaveLength(1);
  });
});

test.describe("several organizations", () => {
  test.afterAll(cleanup);

  test("a user in two organizations switches between them and only ever sees the active one's data", async ({ page }) => {
    const first = await makeOrg("multi-a");
    const second = await makeOrg("multi-b");
    await addMember(second.id, first.admin, "ADMIN"); // same person, two organizations

    await loginOk(page, first.admin.email);
    const switcher = page.getByRole("combobox", { name: "Organization" });
    await expect(switcher).toBeVisible();

    // Work in the second organization: register a server there.
    await switcher.selectOption({ label: second.name });
    await expect.poll(async () => (await query<{ id: string | null }>(`SELECT "activeOrgId" AS id FROM sessions WHERE "userId" = $1`, [first.admin.id]))[0].id).toBe(second.id);
    await page.goto("/en/servers");
    await page.getByLabel("Hostname").fill("host-of-b");
    await page.getByRole("button", { name: "Register server" }).click();
    await expect(page.getByTestId("credentials")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("host-host-of-b")).toBeVisible();

    // Back to the first organization: the server is not there, and the members are the first one's.
    await page.getByRole("combobox", { name: "Organization" }).selectOption({ label: first.name });
    await expect.poll(async () => (await query<{ id: string | null }>(`SELECT "activeOrgId" AS id FROM sessions WHERE "userId" = $1`, [first.admin.id]))[0].id).toBe(first.id);
    await page.goto("/en/servers");
    await expect(page.getByTestId("host-host-of-b")).toHaveCount(0);
    await page.goto("/en/settings/members");
    await expect(page.getByRole("row").filter({ hasText: first.owner.email })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: second.owner.email })).toHaveCount(0);

    // The choice survives a new sign-in? No: it is per session — but it must be one of MY organizations.
    const rows = await query<{ orgId: string }>(`SELECT "activeOrgId" AS "orgId" FROM sessions WHERE "userId" = $1`, [first.admin.id]);
    expect(rows[0].orgId).toBe(first.id);
  });

  test("a member of organization A cannot see anything of organization B", async ({ page }) => {
    const a = await makeOrg("iso-a");
    const b = await makeOrg("iso-b");
    await loginOk(page, a.owner.email);
    for (const path of ["/en", "/en/servers", "/en/settings/members", "/en/settings/audit"]) {
      await page.goto(path);
      await expect(page.getByText(b.owner.email)).toHaveCount(0);
      await expect(page.getByText(b.name)).toHaveCount(0);
    }
  });
});
