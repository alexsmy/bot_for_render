import os
import sys
import threading
import asyncio
from telegram import Update, WebAppInfo, InlineKeyboardButton, InlineKeyboardMarkup, constants
from telegram.ext import Application, CommandHandler, ContextTypes
from main import app as fastapi_app

# Глобальная переменная для хранения экземпляра приложения бота
bot_app_instance = None

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    web_app_url = os.environ.get("WEB_APP_URL")
    if not web_app_url:
        await update.message.reply_text(
            "Извините, URL веб-приложения не настроен. "
            "Администратор должен установить переменную окружения WEB_APP_URL."
        )
        return

    # Убедимся, что URL заканчивается на /
    if not web_app_url.endswith('/'):
        web_app_url += '/'

    keyboard = [
        [InlineKeyboardButton("📞 Общие звонки", web_app=WebAppInfo(url=web_app_url))],
        [InlineKeyboardButton("🔗 Создать приватную ссылку", web_app=WebAppInfo(url=f"{web_app_url}init_private"))]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)

    await update.message.reply_text(
        "👋 Добро пожаловать!\n\nВыберите режим работы:",
        reply_markup=reply_markup
    )

async def send_private_link_to_user(chat_id: int, link: str):
    if bot_app_instance:
        message_text = (
            f"Приглашаю созвониться по ссылке: {link}\n\n"
            "Ссылка актуальна в течение 3-х часов."
        )
        try:
            await bot_app_instance.bot.send_message(
                chat_id=chat_id,
                text=message_text,
                parse_mode=constants.ParseMode.HTML,
                disable_web_page_preview=True
            )
            return True
        except Exception as e:
            print(f"Не удалось отправить сообщение пользователю {chat_id}: {e}", file=sys.stderr)
            return False
    else:
        print("Экземпляр бота не инициализирован.", file=sys.stderr)
        return False


def run_fastapi():
    import uvicorn
    # Передаем функцию отправки сообщения в FastAPI приложение
    fastapi_app.state.send_message_function = send_private_link_to_user
    uvicorn.run(fastapi_app, host="0.0.0.0", port=8000)

def main() -> None:
    global bot_app_instance
    bot_token = os.environ.get("BOT_TOKEN")
    if not bot_token:
        print("КРИТИЧЕСКАЯ ОШИБКА: Токен бота (BOT_TOKEN) не найден.", file=sys.stderr)
        sys.exit(1)

    fastapi_thread = threading.Thread(target=run_fastapi)
    fastapi_thread.daemon = True
    fastapi_thread.start()
    print("FastAPI сервер запущен в фоновом режиме.")

    application = Application.builder().token(bot_token).build()
    application.add_handler(CommandHandler("start", start))

    bot_app_instance = application

    print("Telegram бот запускается...")
    application.run_polling()

if __name__ == "__main__":
    main()
