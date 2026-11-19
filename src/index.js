
export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Tashkent Commercial AI is running");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
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

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const text = (message.text || message.caption || "").trim();

  try {
    if (!env.TELEGRAM_TOKEN || !env.GEMINI_API_KEY ||
        !env.GITHUB_TOKEN || !env.REELS_KV) {
      throw new Error("Проверь секреты и привязку REELS_KV в Worker.");
    }

    if (text.startsWith("/start")) {
      await sendTelegram(env, chatId,
        "Привет! Я помощник по коммерческой недвижимости.\n\n" +
        "Отправляй фото и видео объекта по одному.\n" +
        "Команда /render — собрать ролик.\n" +
        "Команда /clear — очистить материалы.\n\n" +
        "Также можешь отправить текст объявления для анализа.");
      return;
    }

    const key = "media:" + chatId;

    if (text.startsWith("/clear")) {
      await env.REELS_KV.delete(key);
      await sendTelegram(env, chatId, "Материалы очищены.");
      return;
    }

    if (message.photo || message.video) {
      let fileId;

      if (message.photo) {
        fileId = message.photo[message.photo.length - 1].file_id;
      } else {
        fileId = message.video.file_id;
      }

      const saved = await env.REELS_KV.get(key, "json") || [];

      if (saved.length >= 20) {
        await sendTelegram(env, chatId,
          "Достигнут лимит 20 файлов. Отправь /render или /clear.");
        return;
      }

      saved.push(fileId);

      await env.REELS_KV.put(key, JSON.stringify(saved), {
        expirationTtl: 86400
      });

      await sendTelegram(env, chatId,
        "Материал принят. Всего файлов: " + saved.length +
        "\nОтправь следующий файл или команду /render.");
      return;
    }

    if (text.startsWith("/render")) {
      const saved = await env.REELS_KV.get(key, "json");

      if (!saved || saved.length === 0) {
        await sendTelegram(env, chatId,
          "Сначала отправь фотографии или видео.");
        return;
      }

      const response = await fetch(
        "https://api.github.com/repos/Aizen8977/tashkent-commercial-ai/actions/workflows/render-reel.yml/dispatches",
        {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.GITHUB_TOKEN,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ref: "main",
            inputs: {
              chat_id: String(chatId),
              file_ids: saved.join("\n")
            }
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error("GitHub API " + response.status + ": " + errorText);
      }

      await env.REELS_KV.delete(key);

      await sendTelegram(env, chatId,
        "Материалы переданы на монтаж. Когда ролик будет готов, я отправлю его сюда.");
      return;
    }

    if (!text || text.startsWith("/")) {
      await sendTelegram(env, chatId,
        "Отправь описание объекта, фото или видео. Для монтажа используй /render.");
      return;
    }

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

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" +
      encodeURIComponent(env.GEMINI_API_KEY);

    let data = null;
    let lastError = "Gemini временно недоступен.";

    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      const responseText = await response.text();
      try {
        data = JSON.parse(responseText);
      } catch {
        data = {};
      }

      if (response.ok) break;

      lastError = data?.error?.message || "Ошибка Gemini API: " + response.status;

      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
        throw new Error(lastError);
      }

      await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "").join("\n").trim();

    if (!answer) throw new Error("Gemini не вернул текстовый ответ.");

    await sendTelegram(env, chatId, answer.slice(0, 4000));

  } catch (error) {
    console.error("Processing error:", error.message);
    try {
      await sendTelegram(env, chatId,
        "Не удалось обработать запрос.\nПричина: " + error.message);
    } catch (telegramError) {
      console.error("Telegram error:", telegramError.message);
    }
  }
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

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error("Telegram send error: " + JSON.stringify(result));
  }
}
