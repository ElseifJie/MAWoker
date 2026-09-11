import { expect, test, type Page } from "@playwright/test";

const sessionId = "00000000-0000-4000-8000-000000000401";

async function signIn(page: Page, email: string) {
  await expect(
    page.getByRole("heading", { name: "Sign in to your workspace" }),
  ).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("acceptance-password");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("ordinary user completes the production browser workflow", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await signIn(page, "user-a@example.com");

  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await expect(page.getByLabel("Agent")).toHaveValue(
    "00000000-0000-4000-8000-000000000101",
  );
  await expect
    .poll(async () => (await context.cookies()).map(({ name }) => name))
    .toContain("pwa_session");

  await page.getByLabel("File picker").setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("acceptance input"),
  });
  await expect(page.getByText("Ready")).toBeVisible();
  await page.getByLabel("Task message").fill("Prepare an acceptance report");
  await page.getByRole("button", { name: "Send task" }).click();

  await expect(
    page.getByRole("heading", { name: "Prepare an acceptance report" }),
  ).toBeVisible();
  await expect(page.getByText("brief.txt")).toBeVisible();
  await expect(page.getByText("Acceptance report ready.")).toBeVisible();
  await expect(page.getByText("must remain private")).toHaveCount(0);
  await expect(page.getByText("Wrote acceptance-report.md")).toBeVisible();

  await page.goto(`/sessions/${sessionId}`);
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
  await expect(
    page.getByRole("heading", { name: "Prepare an acceptance report" }),
  ).toBeVisible();
  await expect(page.getByText("brief.txt")).toBeVisible();

  const workspace = page.locator(".session-workspace");
  const rail = page.getByRole("complementary", { name: "Session side panel" });
  const columnCount = () =>
    workspace
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns)
      .then((value) => value.split(" ").length);

  await expect(rail).toBeVisible();
  expect(await columnCount()).toBe(2);

  await page.getByRole("button", { name: "Collapse side panel" }).click();
  await expect(rail).not.toBeVisible();
  expect(await columnCount()).toBe(1);

  await page.getByRole("button", { name: /Open side panel/ }).click();
  await expect(rail).toBeVisible();

  await expect(rail.getByRole("heading", { name: "Artifacts" })).toBeVisible();
  await rail.getByRole("button", { name: /acceptance-report\.txt/ }).click();
  const preview = rail.getByRole("region", {
    name: "Preview of acceptance-report.txt",
  });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("acceptance artifact");
  await expect(preview.getByRole("link", { name: "Download" })).toBeVisible();
  await preview.getByRole("button", { name: "Close preview" }).click();
  await expect(preview).toHaveCount(0);

  // Collapsed, the topbar button has to say what the hidden panel holds.
  await page.getByRole("button", { name: "Collapse side panel" }).click();
  await expect(
    page.getByRole("button", { name: /Open side panel, 1 artifact/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Open side panel/ }).click();
  await expect(rail).toBeVisible();

  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Add the risk section");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Message queued.")).toBeVisible();
  await page.getByRole("button", { name: "Interrupt Session" }).click();
  await expect(page.getByText("Interrupt requested.")).toBeVisible();

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "New personal Agent" }).click();
  await page.getByLabel("Agent name").fill("Private reviewer");
  await page.getByLabel("Description").fill("Checks reports");
  await page.getByLabel("Model").selectOption("model-a");
  await page.getByLabel("System Prompt").fill("Review safely.");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await expect(page.getByText("Private reviewer")).toBeVisible();

  await page.getByRole("button", { name: "Edit Private reviewer" }).click();
  await page.getByLabel("Agent name").fill("Private editor");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Private editor")).toBeVisible();
  await page.getByRole("button", { name: "Delete Private editor" }).click();
  await page
    .getByRole("dialog", { name: "Delete personal Agent?" })
    .getByRole("button", { name: "Delete Agent" })
    .click();
  await expect(page.getByText("Private editor")).toHaveCount(0);

  await page.getByRole("link", { name: "My files" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download acceptance-report.txt" })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("acceptance-report.txt");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe("acceptance artifact");

  await page
    .getByRole("link", { name: /Prepare an acceptance report/ })
    .click();
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("button", { name: "Archive Session" }).click();
  await expect(
    page.getByRole("button", { name: "Restore Session" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore Session" }).click();
  await page.getByRole("button", { name: "Session actions" }).click();
  await page
    .getByRole("button", { name: "Delete Session permanently" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete Session permanently?",
  });
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByText("Permanent deletion pending")).toBeVisible();
});

test("administrator completes core lifecycle in Chromium", async ({ page }) => {
  await page.goto("/admin/platform-agents");
  await signIn(page, "admin@example.com");

  await expect(
    page.getByRole("heading", { name: "Platform Agents" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New platform Agent" }).click();
  await page.getByLabel("Agent name").fill("Operations Agent");
  await page.getByLabel("Description").fill("Runs operations");
  await page.getByLabel("Model").fill("model-a");
  await page.getByLabel("System Prompt").fill("Operate safely.");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await expect(page.getByText("Operations Agent")).toBeVisible();

  await page.getByRole("button", { name: "Edit Operations Agent" }).click();
  await page.getByLabel("Agent name").fill("Operations Lead");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Operations Lead")).toBeVisible();

  await page.getByRole("link", { name: "Users" }).click();
  await page
    .getByLabel("Default Agent for user-a@example.com", { exact: true })
    .selectOption("00000000-0000-4000-8000-000000000102");
  await page
    .getByRole("button", {
      name: "Save default Agent for user-a@example.com",
    })
    .click();
  await expect(page.getByText("Default Agent saved.")).toBeVisible();

  const quotas = [
    ["Personal Agent limit for user-a@example.com", "12"],
    ["Concurrent Session limit for user-a@example.com", "3"],
    ["Daily Session limit for user-a@example.com", "30"],
    ["Monthly token limit for user-a@example.com", "2000"],
  ] as const;
  for (const [label, value] of quotas) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page
    .getByRole("button", { name: "Save quotas for user-a@example.com" })
    .click();
  await expect(page.getByText("Quotas saved.")).toBeVisible();

  await page.getByRole("link", { name: "Platform Agents" }).click();
  await page.getByRole("button", { name: "Disable Operations Lead" }).click();
  await expect(
    page.getByRole("button", { name: "Enable Operations Lead" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete Operations Lead" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Delete platform Agent?",
  });
  await dialog.getByRole("button", { name: "Delete Agent" }).click();
  await expect(
    dialog.getByText(
      "This Agent is still assigned to users or referenced by Sessions.",
    ),
  ).toBeVisible();
});

test("theme preference is painted before the bundle and survives a reload", async ({
  page,
}) => {
  const served = await (await page.request.get("/")).text();
  // The inline resolver must run before the module bundle, or a stored dark
  // preference flashes the light canvas on every load.
  expect(served.indexOf("pwa.theme")).toBeGreaterThan(-1);
  expect(served.indexOf('type="module"')).toBeGreaterThan(
    served.indexOf("pwa.theme"),
  );

  await page.goto("/");
  await signIn(page, "user-a@example.com");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("light");

  await page.getByLabel("Theme").selectOption("dark");
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("dark");
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe("rgb(17, 23, 25)");

  await page.goto("/settings");
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("dark");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Theme")).toHaveValue("dark");
});

test("session workspace keeps the transcript and side panel side by side", async ({
  page,
}) => {
  await page.goto("/");
  await signIn(page, "user-a@example.com");
  await page.getByLabel("Task message").fill("Check the session layout");
  await page.getByRole("button", { name: "Send task" }).click();
  await expect(
    page.getByRole("heading", { name: "Check the session layout" }),
  ).toBeVisible();

  const workspace = page.locator(".session-workspace");
  const rail = page.getByRole("complementary", {
    name: "Session side panel",
  });
  const columnCount = () =>
    workspace
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns)
      .then((value) => value.split(" ").length);

  await expect(rail).toBeVisible();
  expect(await columnCount()).toBe(2);

  await page.getByRole("button", { name: "Collapse side panel" }).click();
  await expect(rail).not.toBeVisible();
  expect(await columnCount()).toBe(1);

  await page.getByRole("button", { name: /Open side panel/ }).click();
  await expect(rail).toBeVisible();
  expect(await columnCount()).toBe(2);
});
