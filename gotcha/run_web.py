#!/usr/bin/env python3
"""Start the web app.

    export GOTCHA_ADMIN_KEY='something-only-you-know'   # optional but handy
    python3 run_web.py

Then open http://localhost:8000/ . To let other people reach it from outside your
house you need a public URL - see the README section "Putting the web app online".
"""

from gotcha.webapp import main

if __name__ == "__main__":
    main()
