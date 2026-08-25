"""python -m agent_tools 入口。"""

import sys

from .cli import main

raise SystemExit(main(sys.argv[1:]))
