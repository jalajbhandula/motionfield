/**
 * WS2 Settings → Models & LLMs e2e (GENERATION_PROVIDER=mock):
 *  - the local + self-hosted endpoint groups render with honest statuses;
 *    every local provider is pinned to a dead port (127.0.0.1:9) first, so
 *    probes can never reach a real Ollama/LM Studio on the dev machine
 *  - open-weights only: no closed provider is listed or accepted
 *  - an endpoint key saves (encrypted server-side), shows "key saved", and
 *    never reaches the DOM or another user's API view
 *  - a per-task route pick persists across reload; "Use suggested" writes the
 *    ollama route in one click; the Provider-Test model field reaches the API
 *  - the Offline toggle persists → new agent sessions start in offline mode
 *    and the assistant header shows Offline
 *  - ownership: another user's rows are invisible (404 on GET/DELETE/PUT)
 *  - refusals: unauthenticated 401, closed provider ids 404
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const DEAD = "http://127.0.0.1:9";
const KEY = "sk-test-abc-123";

/** The pglite post-signup hook races the user row's commit on the run's first
 *  sign-up (pre-existing flake - ensureProfile already retries). Retry with a
 *  fresh email each attempt: a failed sign-up can still leave the user row. */
async function signUp(request: APIRequestContext, name: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await request.post("/api/auth/sign-up/email", {
      data: { email: `ws2-llm-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 6)}@test.local`, password: "test-pass-1234", name },
    });
    if (r.ok()) return;
    if (attempt === 3) expect(r.ok(), `sign-up: ${await r.text()}`).toBeTruthy();
    await new Promise((res) => setTimeout(res, 500));
  }
}

test.describe("ws2 models & llms settings", () => {
  test("full pass: dead-port probes, open-weights only, suggested route, key secrecy, offline session, ownership 404", async ({ page }) => {
    const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3100").origin;
    await signUp(page.request, "WS2 LLM Settings");

    // pin every local provider - and the custom endpoint used by Test - at a
    // dead port before the page loads: probes refuse instantly, nothing real
    // is contacted
    for (const id of ["ollama", "lmstudio", "llamacpp", "vllm", "custom"]) {
      const r = await page.request.put(`/api/llm/providers/${id}`, { data: { baseUrl: DEAD } });
      expect(r.status(), `${id}: ${await r.text()}`).toBe(200);
    }

    // API surface: unauthenticated callers get 401
    const anon = await pwRequest.newContext();
    expect((await anon.get(`${origin}/api/llm/providers`)).status()).toBe(401);
    await anon.dispose();

    await page.goto("/settings/models");
    await expect(page.getByTestId("models-panel")).toBeVisible();
    await expect(page.getByTestId("group-local")).toBeVisible();
    await expect(page.getByTestId("group-endpoint")).toBeVisible();
    await expect(page.getByTestId("group-api")).toHaveCount(0);
    await expect(page.getByTestId("group-cli")).toHaveCount(0);
    // dead port → deterministic "not detected" (never the machine's ollama)
    await expect(page.getByTestId("provider-ollama")).toContainText("not detected");

    // open-weights only: the provider list is self-hosted runtimes + custom
    const listed = await (await page.request.get("/api/llm/providers")).json() as
      { groups: { providers: { id: string }[] }[] };
    expect(listed.groups.flatMap((g) => g.providers.map((p) => p.id)).sort())
      .toEqual(["custom", "llamacpp", "lmstudio", "ollama", "vllm"]);

    // "Use suggested" on an unrouted task PUTs ollama:qwen3.5:9b in one click
    const sugBtn = page.getByTestId("suggested-judge");
    await expect(sugBtn).toBeVisible();
    const sugPut = page.waitForResponse((r) =>
      r.url().includes("/api/llm/routes/judge") && r.request().method() === "PUT");
    await sugBtn.click();
    expect((await sugPut).status()).toBe(200);
    await expect(page.getByTestId("task-provider-judge")).toHaveValue("ollama");
    await expect(page.getByTestId("task-model-judge")).toHaveValue("qwen3.5:9b");
    await expect(page.getByTestId("suggested-judge")).toHaveCount(0);

    // save an endpoint key via the UI → "key saved", input cleared
    await page.getByTestId("key-custom").fill(KEY);
    const keySave = page.waitForResponse((r) => r.url().includes("/api/llm/providers/custom") && r.request().method() === "PUT");
    await page.getByTestId("save-custom").click();
    expect((await keySave).status()).toBe(200);
    await expect(page.getByTestId("key-status-custom")).toContainText("key saved");
    // the key never lands in the serialized DOM (password value is a
    // property, and the draft clears after save regardless)
    expect(await page.content()).not.toContain(KEY);

    // pick writer → custom:my-model and save - wait for the PUT to land
    await page.getByTestId("task-provider-writer").selectOption("custom");
    await page.getByTestId("task-model-writer").fill("my-model");
    const routeSave = page.waitForResponse((r) => r.url().includes("/api/llm/routes/writer") && r.request().method() === "PUT");
    await page.getByTestId("task-save-writer").click();
    expect((await routeSave).status(), await (await routeSave).text()).toBe(200);

    // reload → both picks are still there (server-persisted)
    await page.reload();
    await expect(page.getByTestId("task-provider-writer")).toHaveValue("custom");
    await expect(page.getByTestId("task-model-writer")).toHaveValue("my-model");
    await expect(page.getByTestId("task-provider-judge")).toHaveValue("ollama");

    // GET /api/llm/routes agrees
    const routes = await (await page.request.get("/api/llm/routes")).json();
    expect(routes.routes.writer).toMatchObject({ providerId: "custom", model: "my-model" });
    expect(routes.routes.judge).toMatchObject({ providerId: "ollama", model: "qwen3.5:9b" });

    // saved key never leaves the API
    const prov = await (await page.request.get("/api/llm/providers")).json();
    expect(JSON.stringify(prov)).not.toContain(KEY);

    // the Provider-Test model field reaches /api/llm/test (dead base URL →
    // fast, honest failure; the point is the request carries the model)
    await page.getByTestId("model-custom").fill("my-model-2");
    const testReq = page.waitForRequest((r) => r.url().includes("/api/llm/test") && r.method() === "POST");
    await page.getByTestId("test-custom").click();
    expect((await testReq).postDataJSON()).toMatchObject({ providerId: "custom", model: "my-model-2" });
    await expect(page.getByTestId("test-result-custom")).toContainText(/failed|ok/);

    // Offline toggle flips + persists
    const prefSave = page.waitForResponse((r) => r.url().includes("/api/llm/prefs") && r.request().method() === "PUT");
    await page.getByTestId("offline-toggle").click();
    expect((await prefSave).status()).toBe(200);
    await expect(page.getByTestId("offline-toggle")).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(page.getByTestId("offline-toggle")).toHaveAttribute("aria-checked", "true");

    // a new agent session defaults to offline, and the assistant header
    // picker shows Offline for it
    const sr = await page.request.post("/api/agent/sessions", { data: {} });
    expect(sr.status()).toBe(201);
    const { session } = await sr.json();
    expect(session.context?.mode).toBe("offline");
    await page.goto("/ai-assistant");
    await expect(page.getByTestId("mode-menu-button")).toContainText("Offline");
    await page.goto("/settings/models");
    await expect(page.getByTestId("models-panel")).toBeVisible();

    // ownership: a second user's view is blind to this user's rows
    const other = await pwRequest.newContext({ baseURL: origin });
    await signUp(other, "WS2 Other User");
    expect((await other.get("/api/llm/providers/custom")).status()).toBe(404);
    expect((await other.delete("/api/llm/providers/custom")).status()).toBe(404);
    expect((await other.put("/api/llm/providers/not-a-provider", { data: { apiKey: "x" } })).status()).toBe(404);
    const otherView = await (await other.get("/api/llm/providers")).json();
    expect(JSON.stringify(otherView)).not.toContain(KEY);
    await other.dispose();

    // closed providers don't exist server-side - neither a key nor a route
    // can be saved for them
    for (const id of ["openai", "anthropic", "gemini", "claude-code", "codex"]) {
      expect((await page.request.put(`/api/llm/providers/${id}`, { data: { apiKey: "x" } })).status(), id).toBe(404);
      expect((await page.request.put("/api/llm/routes/writer", { data: { providerId: id, model: "m" } })).status(), id).toBe(404);
    }

    // a test-connection against the (dead) custom endpoint fails truthfully
    const t = await (await page.request.post("/api/llm/test", {
      data: { providerId: "custom", model: "my-model" },
    })).json();
    expect(t.ok).toBe(false);
    expect(JSON.stringify(t)).not.toContain(KEY);
  });
});
