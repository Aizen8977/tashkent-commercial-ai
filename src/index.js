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
  const text = message.text || message.caption || "";

  try {
    if (text.startsWith("/start")) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId,
        "Привет! Я помощник по коммерческой недвижимости Ташкента. Отправь описание объекта текстом.");
      return;
    }

    if (!text) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId,
        "Отправь текстовое описание объекта.");
      return;
    }

    const prompt =
      "Ты помощник по коммерческой недвижимости Ташкента. Проанализируй объект. Выдели тип, район, адрес, площадь, этаж, состояние, цену и контакты. Не выдумывай отсутствующие данные. Подготовь объявление на русском языке.\n\n" +
      text;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" +
      encodeURIComponent(env.GEMINI_API_KEY),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini error:", response.status, JSON.stringify(data));
      await sendTelegram(env.TELEGRAM_TOKEN, chatId,
        "Ошибка Gemini: " + response.status + ". Проверь ключ и модель.");
      return;
    }

    const answer = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "").join("\n");

    await sendTelegram(env.TELEGRAM_TOKEN, chatId,
      answer || "Gemini не вернул текст. Попробуй ещё раз.");

  } catch (error) {
    console.error("Processing error:", error);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId,
      "Ошибка при обработке объявления. Попробуй позже.");
  }
}

async function sendTelegram(token, chatId, text) {
  const response = await fetch(
    "https://api.telegram.org/bot" + token + "/sendMessage",
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
