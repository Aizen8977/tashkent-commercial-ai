
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

    if (!message?.chat?.id) {
      return new Response("OK");
    }

    ctx.waitUntil(handleMessage(message, env));

    return new Response("OK");
  }
};

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text || message.caption || "";

  try {
    if (!env.TELEGRAM_TOKEN || !env.GEMINI_API_KEY) {
      throw new Error("Не настроены секреты Worker.");
    }

    if (text.startsWith("/start")) {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Привет! Я помощник по коммерческой недвижимости Ташкента.\n\nОтправь описание объекта, и я его проанализирую."
      );
      return;
    }

    if (!text.trim()) {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Отправь текстовое описание объекта."
      );
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
      "Отвечай обычным текстом. Не используй Markdown, символы решётки, звёздочки и другие маркеры форматирования. " +
      "Используй понятные заголовки и списки. " +
      "Не добавляй неподтверждённые сведения.\n\n" +
      "Описание объекта:\n" + text;

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" +
      encodeURIComponent(env.GEMINI_API_KEY);

    let data = null;
    let lastError = "Gemini временно недоступен.";

    const retryStatuses = [429, 500, 502, 503, 504];

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: prompt }]
              }
            ]
          })
        });

        const responseText = await response.text();

        try {
          data = JSON.parse(responseText);
        } catch {
          data = {};
        }

        if (response.ok) {
          break;
        }

        lastError =
          data?.error?.message ||
          "Ошибка Gemini API: " + response.status;

        if (!retryStatuses.includes(response.status)) {
          throw new Error(lastError);
        }

        if (attempt === 3) {
          throw new Error(lastError);
        }

      } catch (error) {
        lastError = error.message || "Ошибка соединения с Gemini.";

        if (
          error.message &&
          error.message.startsWith("Ошибка Gemini API:")
        ) {
          throw error;
        }

        if (attempt === 3) {
          throw new Error(lastError);
        }
      }

      await new Promise(resolve =>
        setTimeout(resolve, 1200 * attempt)
      );
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("\n")
      .trim();

    if (!answer) {
      throw new Error("Gemini не вернул текстовый ответ.");
    }

    await sendTelegram(
      env.TELEGRAM_TOKEN,
      chatId,
      answer.slice(0, 4000)
    );

  } catch (error) {
    console.error("Processing error:", error.message);

    try {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Не удалось обработать объявление.\nПричина: " +
        error.message +
        "\nПопробуй ещё раз позже."
      );
    } catch (telegramError) {
      console.error("Telegram error:", telegramError.message);
    }
  }
}

async function sendTelegram(token, chatId, text) {
  const response = await fetch(
    "https://api.telegram.org/bot" +
    token +
    "/sendMessage",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      "Telegram send error: " + JSON.stringify(result)
    );
  }
}
