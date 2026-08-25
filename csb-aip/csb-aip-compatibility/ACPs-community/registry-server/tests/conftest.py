"""共享的 pytest 基础环境配置。"""

import os
from pathlib import Path

from dotenv import load_dotenv

from tests.support.constants import TEST_DATABASE_DSN

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env", override=False)

TEST_UPLOAD_BASE_PATH = str(PROJECT_ROOT / ".pytest-upload-base")

os.environ["APP_ENV"] = "testing"
os.environ["DATABASE_URL"] = TEST_DATABASE_DSN
# 测试固定覆盖为 32+ 字节 HMAC key，避免 JWT InsecureKeyLengthWarning。
os.environ["SECRET_KEY"] = "test-secret-key-with-32-bytes-minimum-length"
os.environ.setdefault("SM4_ENCRYPTION_KEY", "0123456789abcdeffedcba9876543210")
os.environ.setdefault("AIC_CRC_SALT", "0x00494F41")
os.environ.setdefault("UPLOAD_BASE_PATH", TEST_UPLOAD_BASE_PATH)
# 测试固定启用 CA mock，避免 integration/e2e 误依赖真实 sibling 服务进程。
os.environ["CA_SERVER_MOCK"] = "true"
os.environ.setdefault("REGISTRY_SERVER_INTERNAL_API_TOKEN", "local-registry-server-internal-api-token")
