
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
    if (text.startsWith("/start")) {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Привет! Я помощник по коммерческой недвижимости Ташкента.\n\nОтправь описание объекта текстом, и я его проанализирую."
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

    if (!env.GEMINI_API_KEY || !env.TELEGRAM_TOKEN) {
      throw new Error("Не настроены секреты Worker.");
    }

    const prompt =
      "Ты эксперт по коммерческой недвижимости Ташкента. " +
      "Проанализируй описание объекта. Выдели: тип недвижимости, район, адрес, площадь, этаж, высоту потолков, состояние, цену, цену за квадратный метр и контакты. " +
      "Не выдумывай отсутствующие данные. Если информации нет, укажи «не указано». " +
      "Оцени преимущества и недостатки объекта. " +
      "В конце подготовь грамотный текст объявления на русском языке.\n\n" +
      "Описание объекта:\n" + text;

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" +
      encodeURIComponent(env.GEMINI_API_KEY);

    let response;
    let data;
    const retryStatuses = [429, 500, 502, 503, 504];

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await fetch(url, {
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

        if (!retryStatuses.includes(response.status)) {
          console.error("Gemini API error:", response.status);
          throw new Error("Gemini API error: " + response.status);
        }

        if (attempt === 3) {
          console.error("Gemini retries exhausted:", response.status);
          throw new Error("Gemini временно недоступен: " + response.status);
        }
      } catch (error) {
        if (error.message.startsWith("Gemini API error:") ||
            error.message.startsWith("Gemini временно недоступен:")) {
          throw error;
        }

        console.error("Gemini network error, attempt:", attempt);

        if (attempt === 3) {
          throw new Error("Не удалось подключиться к Gemini.");
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
      throw new Error("Gemini не вернул текст.");
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
        "Не удалось обработать объявление. " +
        error.message +
        "\nПопробуй отправить его ещё раз позже."
      );
    } catch (telegramError) {
      console.error("Telegram notification error:", telegramError.message);
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
    throw new Error("Telegram send error: " + JSON.stringify(result));
  }
}
