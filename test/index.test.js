import test from "node:test";
import assert from "node:assert/strict";
import worker, { analyzeListing, handleMessage } from "../src/index.js";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

test("returns a non-empty Gemini candidate", async () => {
  globalThis.fetch = async () => jsonResponse({
    candidates: [{ content: { parts: [{ text: "Анализ объекта" }] } }]
  });

  assert.equal(await analyzeListing("Помещение 80 м²", "test-api-key"), "Анализ объекта");
});

test("retries Gemini HTTP 429 and 503, then returns the result", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    if (requests === 1) return jsonResponse({ error: { message: "Rate limited" } }, 429);
    if (requests === 2) return jsonResponse({ error: { message: "Temporarily unavailable" } }, 503);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: "Повтор успешен" }] } }] });
  };

  assert.equal(await analyzeListing("Помещение 80 м²", "test-api-key"), "Повтор успешен");
  assert.equal(requests, 3);
});

test("stops Gemini retries at the configured attempt limit", async () => {
  console.error = () => {};
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return jsonResponse({ error: { message: "Still unavailable" } }, 503);
  };

  await assert.rejects(analyzeListing("Текст объекта", "test-api-key"), /HTTP 503/);
  assert.equal(requests, 3);
});

test("reports Gemini HTTP status and sanitized API message", async () => {
  globalThis.fetch = async () => jsonResponse({
    error: { message: "Invalid key test-api-key" }
  }, 403);

  await assert.rejects(
    analyzeListing("Личные данные", "test-api-key"),
    error => {
      assert.match(error.userMessage, /HTTP 403/);
      assert.match(error.userMessage, /Invalid key/);
      assert.doesNotMatch(error.userMessage, /test-api-key|Личные данные/);
      return true;
    }
  );
});

test("reports a successful but empty Gemini response", async () => {
  globalThis.fetch = async () => jsonResponse({
    candidates: [{ content: { parts: [{ text: "  " }] }, finishReason: "STOP" }]
  });

  await assert.rejects(analyzeListing("Текст объекта", "test-api-key"), /пустой текстовый ответ/);
});

test("reports invalid Gemini response JSON", async () => {
  globalThis.fetch = async () => new Response("not-json", { status: 200 });

  await assert.rejects(analyzeListing("Текст объекта", "test-api-key"), /некорректный ответ \(HTTP 200\)/);
});

test("reports a network error without exposing its message", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("request failed for https://example.test/?key=test-api-key");
  };

  await assert.rejects(analyzeListing("Секретный текст", "test-api-key"), error => {
    assert.match(error.userMessage, /Сетевая ошибка/);
    assert.doesNotMatch(error.userMessage, /test-api-key|Секретный текст|example\.test/);
    return true;
  });
});

test("reports a Gemini request timeout", async () => {
  globalThis.fetch = async () => {
    throw new DOMException("request timed out", "TimeoutError");
  };

  await assert.rejects(analyzeListing("Текст объекта", "test-api-key"), /общий лимит 25 секунд/);
});

test("text analysis does not require Reels resources", async () => {
  const sentMessages = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return jsonResponse({ candidates: [{ content: { parts: [{ text: "Готовый анализ" }] } }] });
    }
    if (String(url).includes("api.telegram.org")) {
      sentMessages.push(JSON.parse(options.body).text);
      return jsonResponse({ ok: true, result: {} });
    }
    throw new Error("Unexpected network call");
  };

  await handleMessage(
    { chat: { id: 123 }, text: "Офис 80 м²" },
    { TELEGRAM_TOKEN: "telegram-test-token", GEMINI_API_KEY: "gemini-test-key" }
  );

  assert.deepEqual(sentMessages, ["Готовый анализ"]);
});

test("/start works without Gemini, KV, or GitHub bindings", async () => {
  const sentMessages = [];
  globalThis.fetch = async (_url, options) => {
    sentMessages.push(JSON.parse(options.body).text);
    return jsonResponse({ ok: true, result: {} });
  };

  await handleMessage(
    { chat: { id: 123 }, text: "/start" },
    { TELEGRAM_TOKEN: "telegram-test-token" }
  );

  assert.match(sentMessages[0], /Команда \/render/);
});

test("/clear deletes only the current chat's media list", async () => {
  let deletedKey;
  const sentMessages = [];
  globalThis.fetch = async (_url, options) => {
    sentMessages.push(JSON.parse(options.body).text);
    return jsonResponse({ ok: true, result: {} });
  };

  await handleMessage(
    { chat: { id: 123 }, text: "/clear" },
    {
      TELEGRAM_TOKEN: "telegram-test-token",
      REELS_KV: { async delete(key) { deletedKey = key; } }
    }
  );

  assert.equal(deletedKey, "media:123");
  assert.equal(sentMessages[0], "Материалы очищены.");
});

test("/clearAnything is not treated as /clear", async () => {
  const sentMessages = [];
  globalThis.fetch = async (_url, options) => {
    sentMessages.push(JSON.parse(options.body).text);
    return jsonResponse({ ok: true, result: {} });
  };

  await handleMessage(
    { chat: { id: 123 }, text: "/clearAnything" },
    { TELEGRAM_TOKEN: "telegram-test-token" }
  );

  assert.match(sentMessages[0], /Для монтажа используй \/render/);
});

test("/render dispatches the workflow and clears KV after GitHub accepts it", async () => {
  const sentMessages = [];
  let deletedKey;
  let dispatch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.github.com")) {
      dispatch = { url: String(url), options };
      return new Response(null, { status: 204 });
    }
    sentMessages.push(JSON.parse(options.body).text);
    return jsonResponse({ ok: true, result: {} });
  };

  await handleMessage(
    { chat: { id: 123 }, text: "/render" },
    {
      TELEGRAM_TOKEN: "telegram-test-token",
      GITHUB_TOKEN: "github-test-token",
      REELS_KV: {
        async get() { return ["file-one", "file-two"]; },
        async delete(key) { deletedKey = key; }
      }
    }
  );

  assert.equal(deletedKey, "media:123");
  assert.match(dispatch.url, /render-reel\.yml\/dispatches$/);
  assert.equal(dispatch.options.headers.Authorization, "Bearer github-test-token");
  assert.deepEqual(JSON.parse(dispatch.options.body).inputs, {
    chat_id: "123", file_ids: "file-one\nfile-two"
  });
  assert.match(sentMessages[0], /переданы на монтаж/);
});

test("/render keeps media and reports a GitHub HTTP error safely", async () => {
  console.error = () => {};
  let deleted = false;
  const sentMessages = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.github.com")) {
      return jsonResponse({ message: "Resource not accessible with token github-test-token" }, 403);
    }
    sentMessages.push(JSON.parse(options.body).text);
    return jsonResponse({ ok: true, result: {} });
  };

  await handleMessage(
    { chat: { id: 123 }, text: "/render" },
    {
      TELEGRAM_TOKEN: "telegram-test-token",
      GITHUB_TOKEN: "github-test-token",
      REELS_KV: {
        async get() { return ["file-one"]; },
        async delete() { deleted = true; }
      }
    }
  );

  assert.equal(deleted, false);
  assert.match(sentMessages[0], /HTTP 403/);
  assert.match(sentMessages[0], /Resource not accessible/);
  assert.doesNotMatch(sentMessages[0], /github-test-token/);
  assert.match(sentMessages[0], /Материалы сохранены/);
});

test("/render keeps media and reports GitHub network errors", async () => {
  console.error = () => {};
  let deleted = false;
  const sentMessages = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.github.com")) throw new TypeError("network failure");
    sentMessages.push(JSON.parse(options.body).text);
    return jsonResponse({ ok: true, result: {} });
  };

  await handleMessage(
    { chat: { id: 123 }, text: "/render" },
    {
      TELEGRAM_TOKEN: "telegram-test-token",
      GITHUB_TOKEN: "github-test-token",
      REELS_KV: {
        async get() { return ["file-one"]; },
        async delete() { deleted = true; }
      }
    }
  );

  assert.equal(deleted, false);
  assert.match(sentMessages[0], /сетевая ошибка при запуске монтажа/);
  assert.match(sentMessages[0], /Материалы сохранены/);
});

test("webhook rejects a missing or wrong configured secret", async () => {
  const request = new Request("https://worker.example/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { chat: { id: 123 }, text: "/start" } })
  });
  let scheduled = false;
  const response = await worker.fetch(request, {
    TELEGRAM_WEBHOOK_SECRET: "expected-secret"
  }, { waitUntil() { scheduled = true; } });

  assert.equal(response.status, 401);
  assert.equal(scheduled, false);
});

test("webhook accepts the matching secret and retains compatibility when unset", async () => {
  const sentMessages = [];
  globalThis.fetch = async (_url, options) => {
    sentMessages.push(JSON.parse(options.body).text);
    return jsonResponse({ ok: true, result: {} });
  };
  const body = JSON.stringify({ message: { chat: { id: 123 }, text: "/start" } });
  const env = { TELEGRAM_TOKEN: "telegram-test-token", TELEGRAM_WEBHOOK_SECRET: "expected-secret" };
  const ctx = { waitUntil(promise) { this.pending = promise; } };
  const securedResponse = await worker.fetch(new Request("https://worker.example/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "expected-secret"
    },
    body
  }), env, ctx);
  await ctx.pending;
  assert.equal(securedResponse.status, 200);
  assert.equal(sentMessages.length, 1);

  const legacyCtx = { waitUntil(promise) { this.pending = promise; } };
  const legacyResponse = await worker.fetch(new Request("https://worker.example/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  }), { TELEGRAM_TOKEN: "telegram-test-token" }, legacyCtx);
  await legacyCtx.pending;
  assert.equal(legacyResponse.status, 200);
  assert.equal(sentMessages.length, 2);
});

test("media intake does not require Gemini or GitHub resources", async () => {
  let storedValue;
  const sentMessages = [];
  const kv = {
    async get() { return []; },
    async put(key, value) { storedValue = value; }
  };
  globalThis.fetch = async (_url, options) => {
    sentMessages.push(JSON.parse(options.body).text);
    return jsonResponse({ ok: true, result: {} });
  };

  await handleMessage(
    { chat: { id: 123 }, photo: [{ file_id: "photo-file-id" }] },
    { TELEGRAM_TOKEN: "telegram-test-token", REELS_KV: kv }
  );

  assert.equal(storedValue, JSON.stringify(["photo-file-id"]));
  assert.match(sentMessages[0], /Материал принят/);
});

test("missing Gemini key is isolated to text analysis", async () => {
  console.error = () => {};
  const sentMessages = [];
  globalThis.fetch = async (url, options) => {
    sentMessages.push(JSON.parse(options.body).text);
    return jsonResponse({ ok: true, result: {} });
  };

  await handleMessage(
    { chat: { id: 123 }, text: "Офис 80 м²" },
    { TELEGRAM_TOKEN: "telegram-test-token" }
  );

  assert.match(sentMessages[0], /GEMINI_API_KEY/);
});
