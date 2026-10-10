import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { MemoryList, MemoryState } from "../../apps/web/src/api.js";

const profilePath = "/memories/profile.md";
const workflowPath = "/memories/preferences/workflow.md";
const workflowContent = "Prefer concise answers with concrete verification.";

async function signIn(page: Page, user: "a" | "b") {
  await page.goto("/context");
  await expect(
    page.getByRole("heading", { name: "Sign in to your workspace" }),
  ).toBeVisible();
  await page.getByLabel("Email").fill(`user-${user}@example.com`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("acceptance-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/context$/);
  await expect(
    page.getByRole("heading", { name: "Context", exact: true }),
  ).toBeVisible();
}

async function readMemory(request: APIRequestContext): Promise<MemoryList> {
  const response = await request.get("/api/v1/memory");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(JSON.stringify(body)).not.toMatch(
    /storeId|userId|baseline|snapshotId|candidateId|dreamId/,
  );
  return body;
}

async function save(page: Page, content: string) {
  await page.getByLabel("Content", { exact: true }).fill(content);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/memory/entry") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const state: MemoryState = await response.json();
  expect(state.run).toMatchObject({ kind: "edit", stage: "queued" });
  await expect(page.getByText("Save queued; not saved yet.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Memory saved.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
}

async function setProtected(page: Page, value: boolean) {
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/memory/protect"),
  );
  await page.getByLabel("Protected", { exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const state: MemoryState = await response.json();
  expect(state.protectedPaths.includes(profilePath)).toBe(value);
  await expect(page.getByLabel("Protected", { exact: true })).toBeChecked({
    checked: value,
  });
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
}

test("production Context saves, protects, compresses and isolates personal memory", async ({
  browser,
  context,
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));

  expect((await page.request.get("/api/v1/memory")).status()).toBe(401);
  const invalidLogin = await page.request.post("/api/v1/auth/login", {
    data: { email: "user-a@example.com", password: "wrong-password" },
  });
  expect(invalidLogin.status()).toBe(401);
  await signIn(page, "a");
  expect(await context.cookies()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "pwa_session",
        value: "A",
        httpOnly: true,
      }),
    ]),
  );
  await expect(
    page.getByRole("link", { name: "Context", exact: true }),
  ).toBeVisible();
  const directory = page.getByRole("region", { name: "Memory directory" });
  for (const path of ["/.abstract.md", "/.overview.md", profilePath]) {
    await expect(
      directory.getByRole("button", { name: path, exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByLabel("Automatic Dream")).not.toBeChecked();

  await directory
    .getByRole("button", { name: profilePath, exact: true })
    .click();
  await expect(page.getByLabel("Path", { exact: true })).toBeDisabled();
  await save(page, "User A confirms a preference for short technical reports.");
  await setProtected(page, true);
  await expect(
    directory.getByRole("listitem").filter({ hasText: profilePath }),
  ).toContainText("Protected");
  await setProtected(page, false);
  await setProtected(page, true);

  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page.getByLabel("Path", { exact: true }).fill(workflowPath);
  await save(page, workflowContent);
  await expect(page.getByLabel("Path", { exact: true })).toBeDisabled();

  const before = await readMemory(page.request);
  const capacity = page.getByRole("region", { name: "Memory capacity" });
  await expect(capacity).toContainText(
    `${before.capacity.count} / 2,000 entries`,
  );
  await expect(capacity).toContainText(`${before.capacity.bytes} bytes total`);
  await expect(capacity).toContainText("Byte budget: Not configured");
  await expect(capacity).toContainText("Level: normal");

  const compressResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/memory/compress"),
  );
  await page.getByRole("button", { name: "Compress", exact: true }).click();
  const queued = await compressResponse;
  expect(queued.status()).toBe(202);
  expect((await queued.json()).run).toMatchObject({
    kind: "compress",
    stage: "queued",
  });
  await expect(
    page.getByText("Compress queued; not completed yet."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Compress", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Compress completed.", { exact: true }),
  ).toBeVisible();
  const after = await readMemory(page.request);
  expect(after.state.run).toMatchObject({
    kind: "compress",
    stage: "completed",
    before: before.capacity,
    after: after.capacity,
    error: null,
  });
  expect(after.capacity.count).toBeLessThan(before.capacity.count);
  expect(after.state.protectedPaths).toContain(profilePath);
  expect(
    after.entries.find((entry) => entry.path === profilePath)?.content,
  ).toBe("User A confirms a preference for short technical reports.");
  expect(
    after.entries.find((entry) => entry.path === workflowPath)?.content,
  ).toBe(workflowContent);
  const packed = after.entries.filter((entry) =>
    entry.path.startsWith("/memories/events/acceptance/"),
  );
  expect(packed).toHaveLength(1);
  for (const [path, content] of [
    [
      "/memories/events/acceptance/one.md",
      "First acceptance event: budget 8000.",
    ],
    [
      "/memories/events/acceptance/two.md",
      "Second acceptance event: review Friday.",
    ],
  ]) {
    expect(packed[0]!.content).toContain(path);
    expect(packed[0]!.content).toContain(content);
  }
  await expect(capacity).toContainText(
    `${after.capacity.count} / 2,000 entries`,
  );
  await mkdir("test-results/memory", { recursive: true });
  await page.screenshot({
    path: "test-results/memory/context.png",
    fullPage: true,
    animations: "disabled",
  });

  await page.reload();
  await expect(
    directory.getByRole("button", { name: workflowPath, exact: true }),
  ).toBeVisible();
  await directory
    .getByRole("button", { name: workflowPath, exact: true })
    .click();
  await expect(page.getByLabel("Content", { exact: true })).toHaveValue(
    workflowContent,
  );
  await expect(page.getByLabel("Automatic Dream")).not.toBeChecked();

  const other = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  try {
    const otherPage = await other.newPage();
    await signIn(otherPage, "b");
    const bMemory = await readMemory(other.request);
    expect(bMemory.entries.map((entry) => entry.path)).toEqual([
      "/.abstract.md",
      "/.overview.md",
      profilePath,
    ]);
    expect(bMemory.state.protectedPaths).not.toContain(profilePath);
    expect(
      bMemory.entries.find((entry) => entry.path === profilePath)?.content,
    ).not.toContain("User A");
    await expect(
      otherPage.getByRole("button", { name: workflowPath, exact: true }),
    ).toHaveCount(0);
    expect((await readMemory(page.request)).entries).toEqual(after.entries);
  } finally {
    await other.close();
  }
  expect(failures).toEqual([]);
});
