"""PyInstaller で固めるときの入口。

Electron 版では、この実行ファイルが解析エンジン兼ローカルサーバーになる。
（Python も OpenCV も同梱されるので、配布先に何も入っていなくても動く）
"""

import multiprocessing
import sys

from cutgrab.server import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
