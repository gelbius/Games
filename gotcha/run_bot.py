#!/usr/bin/env python3
"""Start the Telegram bot.

    export GOTCHA_BOT_TOKEN='paste-the-token-from-BotFather'
    export GOTCHA_ADMIN_IDS='your-telegram-user-id'      # optional
    python3 run_bot.py

Leave it running for the whole weekend. Stop it with Ctrl-C; the game is saved in
gotcha.db, so starting it again picks up exactly where it left off.
"""

from gotcha.telegram_bot import main

if __name__ == "__main__":
    main()
