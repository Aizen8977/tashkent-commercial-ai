const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_ATTEMPT_TIMEOUT_MS = 20_000;
const GEMINI_TOTAL_TIMEOUT_MS = 25_000;
const GEMINI_MAX_ATTEMPTS = 3;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4_000;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Tashkent Commercial AI is running");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!isAuthorizedTelegramWebhook(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const message = update.message;
    if (!message?.chat?.id) return new Response("OK");

    ctx.waitUntil(handleMessage(message, env));
    return new Response("OK");
  }
};

export async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const text = (message.text || message.caption || "").trim();
  const command = parseCommand(text);

  try {
    if (!env.TELEGRAM_TOKEN) {
      throw new Error("Не настроен секрет TELEGRAM_TOKEN в Worker.");
    }

    if (command === "start") {
      await sendTelegram(env, chatId,
        "Привет! Я помощник по коммерческой недвижимости.\n\n" +
        "Отправляй фото и видео объекта по одному.\n" +
        "Команда /render — собрать ролик.\n" +
        "Команда /clear — очистить материалы.\n\n" +
        "Также можешь отправить текст объявления для анализа.");
      return;
    }

    if (command === "clear") {
      const kv = requireBinding(env.REELS_KV, "REELS_KV");
      await kv.delete(mediaKey(chatId));
      await sendTelegram(env, chatId, "Материалы очищены.");
      return;
    }

    if (message.photo || message.video) {
      const kv = requireBinding(env.REELS_KV, "REELS_KV");
      const fileId = message.photo
        ? message.photo[message.photo.length - 1]?.file_id
        : message.video.file_id;
      if (!fileId) throw new Error("В сообщении не найден идентификатор медиафайла.");

      const key = mediaKey(chatId);
      const saved = await kv.get(key, "json") || [];
      if (saved.length >= 20) {
        await sendTelegram(env, chatId,
          "Достигнут лимит 20 файлов. Отправь /render или /clear.");
        return;
      }

      saved.push(fileId);
      await kv.put(key, JSON.stringify(saved), { expirationTtl: 86400 });
      await sendTelegram(env, chatId,
        "Материал принят. Всего файлов: " + saved.length +
        "\nОтправь следующий файл или команду /render.");
      return;
    }

    if (command === "render") {
      const kv = requireBinding(env.REELS_KV, "REELS_KV");
      const saved = await kv.get(mediaKey(chatId), "json");
      if (!saved || saved.length === 0) {
        await sendTelegram(env, chatId, "Сначала отправь фотографии или видео.");
        return;
      }

      const githubToken = requireBinding(env.GITHUB_TOKEN, "GITHUB_TOKEN");
      await dispatchReelWorkflow(chatId, saved, githubToken);

      await kv.delete(mediaKey(chatId));
      await sendTelegram(env, chatId,
        "Материалы переданы на монтаж. Когда ролик будет готов, я отправлю его сюда.");
      return;
    }

    if (!text || text.startsWith("/")) {
      await sendTelegram(env, chatId,
        "Отправь описание объекта, фото или видео. Для монтажа используй /render.");
      return;
    }

    const apiKey = requireBinding(env.GEMINI_API_KEY, "GEMINI_API_KEY");
    const answer = await analyzeListing(text, apiKey);
    await sendTelegram(env, chatId, answer);
  } catch (error) {
    const messageText = error instanceof GeminiError
      ? error.userMessage
      : safeOperationalMessage(error);
    // Log only a fixed classification; never log the request, credentials, or provider payload.
    console.error("Telegram message processing failed", {
      category: error instanceof GeminiError ? error.category : "handler"
    });
    try {
      await sendTelegram(env, chatId, "Не удалось обработать запрос.\n" + messageText);
    } catch {
      console.error("Telegram error notification failed");
    }
  }
}

export async function analyzeListing(text, apiKey) {
  const prompt =
    "Ты эксперт по коммерческой недвижимости Ташкента. " +
    "Подробно проанализируй описание объекта. " +
    "Выдели тип недвижимости, район, адрес, площадь, этаж, высоту потолков, состояние, цену, цену за квадратный метр и контакты. " +
    "Не выдумывай отсутствующие данные. Если информации нет, напиши «не указано». " +
    "Рассчитай цену за квадратный метр, если известны площадь и месячная цена. " +
    "Оцени преимущества, недостатки и потенциальные риски объекта. " +
    "Подготовь отдельный грамотный текст объявления на русском языке. " +
    "Отвечай обычным текстом, используй понятные заголовки и списки. " +
    "Не добавляй неподтверждённые сведения.\n\nОписание объекта:\n" + text;

  let response;
  let data;
  const deadline = Date.now() + GEMINI_TOTAL_TIMEOUT_MS;
  const retryableStatuses = new Set([429, 500, 502, 503, 504]);

  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new GeminiError("timeout",
        "Gemini не ответил в пределах 25 секунд. Попробуй отправить описание ещё раз.");
    }

    try {
      response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          GEMINI_MODEL + ":generateContent?key=" + encodeURIComponent(apiKey),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: AbortSignal.timeout(Math.min(GEMINI_ATTEMPT_TIMEOUT_MS, remainingMs))
        }
      );
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new GeminiError(
        timedOut ? "timeout" : "network",
        timedOut
          ? "Gemini не ответил в течение отведённого времени (общий лимит 25 секунд)."
          : "Сетевая ошибка при подключении к Gemini. Проверь доступ Worker к API и повтори запрос."
      );
    }

    let responseData;
    try {
      responseData = await response.json();
    } catch {
      throw new GeminiError("invalid-response",
        "Gemini вернул некорректный ответ (HTTP " + response.status + ").");
    }

    if (response.ok) {
      data = responseData;
      break;
    }

    const apiMessage = sanitizeApiMessage(responseData?.error?.message, apiKey);
    const diagnostic = "Gemini API вернул HTTP " + response.status +
      (apiMessage ? ". Сообщение API: " + apiMessage : ". Текст ошибки API отсутствует.");

    if (!retryableStatuses.has(response.status) || attempt === GEMINI_MAX_ATTEMPTS) {
      throw new GeminiError("http", diagnostic);
    }

    const backoffMs = 300 * (2 ** (attempt - 1));
    if (Date.now() + backoffMs >= deadline) {
      throw new GeminiError("http", diagnostic + " Повторные попытки исчерпаны по тайм-ауту.");
    }
    await new Promise(resolve => setTimeout(resolve, backoffMs));
  }

  if (data?.promptFeedback?.blockReason) {
    throw new GeminiError("blocked", "Gemini отклонил запрос: " +
      String(data.promptFeedback.blockReason).slice(0, 120) + ". Проверь текст и повтори запрос.");
  }

  const candidate = data?.candidates?.[0];
  if (!candidate || !Array.isArray(candidate.content?.parts)) {
    throw new GeminiError("invalid-response",
      "Gemini вернул ответ без кандидата с текстом (HTTP " + response.status + ").");
  }

  const answer = candidate.content.parts
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("\n")
    .trim();
  if (!answer) {
    const reason = candidate.finishReason ? " Причина: " + candidate.finishReason + "." : "";
    throw new GeminiError("empty", "Gemini вернул пустой текстовый ответ (HTTP " +
      response.status + ")." + reason + " Попробуй отправить описание ещё раз.");
  }

  return answer.slice(0, MAX_TELEGRAM_MESSAGE_LENGTH);
}

class GeminiError extends Error {
  constructor(category, userMessage) {
    super(userMessage);
    this.name = "GeminiError";
    this.category = category;
    this.userMessage = userMessage;
  }
}

function requireBinding(value, name) {
  if (!value) throw new Error("Не настроен ресурс " + name + " в Cloudflare Worker.");
  return value;
}

function mediaKey(chatId) {
  return "media:" + chatId;
}

function parseCommand(text) {
  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/);
  return match ? match[1].toLowerCase() : null;
}

function isAuthorizedTelegramWebhook(request, env) {
  // Backward compatible: the current webhook keeps working until a secret is configured.
  if (!env.TELEGRAM_WEBHOOK_SECRET) return true;
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  return constantTimeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET);
}

function constantTimeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}

async function dispatchReelWorkflow(chatId, saved, githubToken) {
  let response;
  try {
    response = await fetch(
      "https://api.github.com/repos/Aizen8977/tashkent-commercial-ai/actions/workflows/render-reel.yml/dispatches",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + githubToken,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { chat_id: String(chatId), file_ids: saved.join("\n") }
        })
      }
    );
  } catch {
    throw new Error("GitHub Actions: сетевая ошибка при запуске монтажа. Материалы сохранены; повтори /render.");
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    let responseData = null;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      // Some gateways return plain text or HTML instead of GitHub's JSON error format.
    }

    const contentType = safeHeader(
      "Content-Type", response.headers.get("Content-Type"), githubToken, 120, chatId
    ) || "не указан";
    const requestId = safeHeader(
      "X-GitHub-Request-Id", response.headers.get("X-GitHub-Request-Id"), githubToken, 120, chatId
    ) || "не указан";
    const acceptedPermissions = safeHeader(
      "X-Accepted-GitHub-Permissions",
      response.headers.get("X-Accepted-GitHub-Permissions"),
      githubToken,
      200,
      chatId
    ) || "не указан";
    const rawMessage = typeof responseData?.message === "string"
      ? responseData.message
      : isPlainTextContentType(contentType)
        ? responseText
        : "Ответ GitHub не содержит безопасного текстового сообщения.";
    const safeMessage = sanitizeGitHubMessage(rawMessage, githubToken, chatId);

    throw new Error(
      "GitHub Actions: HTTP " + response.status +
      "; Content-Type: " + contentType +
      "; X-GitHub-Request-Id: " + requestId +
      "; X-Accepted-GitHub-Permissions: " + acceptedPermissions +
      "; Сообщение GitHub: " + (safeMessage || "не указано") +
      ". Материалы сохранены; после исправления повтори /render."
    );
  }
}

function safeHeader(name, value, githubToken, maxLength, chatId) {
  if (!value) return "";
  let safeValue = value
    .replaceAll(githubToken, "[секрет скрыт]")
    .replace(/https?:\/\/[^\s]+/gi, "[ссылка скрыта]")
    .replace(/Aizen8977/gi, "[пользователь скрыт]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[контакт скрыт]")
    .replace(/@[A-Za-z0-9_-]{1,39}/g, "[пользователь скрыт]")
    .replace(/\b(?:user|account|login)\s*[:=]?\s*[A-Za-z0-9_-]{1,39}/gi,
      match => match.replace(/[A-Za-z0-9_-]+$/, "[пользователь скрыт]"))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, maxLength);

  safeValue = replaceDelimitedIdentifier(safeValue, String(chatId));

  if (name === "Content-Type") {
    const match = safeValue.match(/^([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+)(?:\s*;\s*charset=([A-Za-z0-9._-]+))?$/i);
    return match
      ? match[1].toLowerCase() + (match[2] ? "; charset=" + match[2].toLowerCase() : "")
      : "";
  }

  if (name === "X-Accepted-GitHub-Permissions") {
    const allowedPermissions = new Set([
      "actions", "attestations", "checks", "contents", "deployments", "discussions",
      "id-token", "id_token", "issues", "metadata", "packages", "pages",
      "pull-requests", "pull_requests", "repository-projects", "repository_projects",
      "security-events", "security_events", "statuses", "workflows"
    ]);
    const permissions = safeValue.split(/[;,]/).map(value => value.trim());
    const valid = permissions.length > 0 && permissions.every(permission => {
      const match = permission.match(/^([a-z-]+)=(none|read|write)$/i);
      return match && allowedPermissions.has(match[1].toLowerCase());
    });
    return valid ? permissions.join("; ") : "";
  }

  // Preserve GitHub's correlation ID, while removing secrets, URLs and the caller's exact chat ID.
  return /^[A-Za-z0-9._:-]+$/.test(safeValue) ? safeValue : "";
}

function replaceDelimitedIdentifier(value, identifier) {
  if (!identifier) return value;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(^|[^A-Za-z0-9])" + escaped + "(?=$|[^A-Za-z0-9])", "g");
  return value.replace(pattern, "$1[идентификатор скрыт]");
}

function isPlainTextContentType(contentType) {
  return /^text\/plain(?:\s*;|$)/i.test(contentType);
}

function sanitizeGitHubMessage(message, githubToken, chatId) {
  if (typeof message !== "string" || !message.trim()) return "";
  const safeChatId = String(chatId);
  return message
    .replaceAll(githubToken, "[секрет скрыт]")
    .replace(/Aizen8977/gi, "[пользователь скрыт]")
    .replaceAll(safeChatId, "[идентификатор скрыт]")
    .replace(/https?:\/\/[^\s]+/gi, "[ссылка скрыта]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[контакт скрыт]")
    .replace(/@[A-Za-z0-9_-]{1,39}/g, "[пользователь скрыт]")
    .replace(/\b(?:user|account|login)\s*[:=]?\s*[A-Za-z0-9_-]{1,39}/gi,
      match => match.replace(/[A-Za-z0-9_-]+$/, "[пользователь скрыт]"))
    .replace(/\b\d{5,}\b/g, "[идентификатор скрыт]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 400);
}

function sanitizeApiMessage(message, apiKey) {
  if (typeof message !== "string" || !message.trim()) return "";
  return message
    .replaceAll(apiKey, "[скрытый ключ]")
    .replace(/https?:\/\/[^\s]+/gi, "[ссылка скрыта]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 600);
}

function safeOperationalMessage(error) {
  if (error instanceof Error && error.message.startsWith("Не настроен ресурс ")) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith("GitHub Actions: HTTP ")) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith("GitHub Actions: сетевая ошибка")) {
    return error.message;
  }
  return "Внутренняя ошибка обработчика. Проверьте конфигурацию Worker и повторите запрос.";
}

async function sendTelegram(env, chatId, text) {
  const response = await fetch(
    "https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/sendMessage",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    }
  );

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Telegram returned an invalid response");
  }
  if (!response.ok || !result.ok) throw new Error("Telegram send failed");
}
