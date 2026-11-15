export default {
  async fetch(request, env) {
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

    const chatId = message.chat.id;
    const text = message.text || message.caption || "";

    if (text.startsWith("/start")) {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Привет! Я помощник по коммерческой недвижимости Ташкента. Отправь описание объекта или фото."
      );
      return new Response("OK");
    }

    if (text || message.photo) {
      const prompt =
        "Ты помощник по коммерческой недвижимости Ташкента. Проанализируй сообщение. Выдели тип объекта, район или адрес, площадь, этаж, состояние, цену и контакты. Не выдумывай отсутствующие данные. Составь краткое объявление на русском языке.\n\nСообщение: " +
        text;

      try {
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
        const answer =
          data.candidates?.[0]?.content?.parts
            ?.map(part => part.text || "")
            .join("\n") ||
          "Не удалось разобрать объявление. Попробуй отправить его текстом.";

        await sendTelegram(env.TELEGRAM_TOKEN, chatId, answer);
      } catch {
        await sendTelegram(
          env.TELEGRAM_TOKEN,
          chatId,
          "Получил объявление, но при анализе произошла ошибка."
        );
      }
    } else {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Отправь текстовое описание объекта или фото с подписью."
      );
    }

    return new Response("OK");
  }
};

async function sendTelegram(token, chatId, text) {
  await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}
