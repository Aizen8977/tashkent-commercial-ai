import os
import telebot

TOKEN = os.getenv("TELEGRAM_TOKEN")
bot = telebot.TeleBot(TOKEN)

@bot.message_handler(commands=["start"])
def start(message):
    bot.reply_to(
        message,
        "Привет! Я помощник по коммерческой недвижимости Ташкента. Отправь мне объявление, фото или описание объекта."
    )

@bot.message_handler(content_types=["text", "photo", "video"])
def handle_listing(message):
    bot.reply_to(
        message,
        "Объявление получил. Скоро смогу анализировать объект и готовить публикацию для Instagram."
    )

bot.infinity_polling()
