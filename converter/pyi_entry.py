"""PyInstaller / Nuitka 用の入口（tools/converter/converter.exe）。"""

import sys

from clash_converter.cli import main

if __name__ == "__main__":
    sys.exit(main())
