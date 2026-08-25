"""ACS 文件操作：读取 AIC、清理本地状态。"""

from __future__ import annotations

import glob
import json
import os


def extract_aic(acs_json_path: str) -> str:
    """从 acs.json 读取 AIC（智能体身份码）。

    Args:
        acs_json_path: acs.json 文件路径。

    Returns:
        AIC 字符串；未找到或文件不存在时返回空字符串。
    """
    if not os.path.isfile(acs_json_path):
        return ""
    try:
        with open(acs_json_path, encoding="utf-8") as f:
            payload = json.load(f)
        return str(payload.get("aic") or "")
    except (json.JSONDecodeError, OSError):
        return ""


def has_skills(acs_json_path: str) -> bool:
    """判断 acs.json 是否声明了至少一个 skill。"""
    if not os.path.isfile(acs_json_path):
        return False
    try:
        with open(acs_json_path, encoding="utf-8") as f:
            payload = json.load(f)
        skills = payload.get("skills")
        return isinstance(skills, list) and len(skills) > 0
    except (json.JSONDecodeError, OSError):
        return False


def clear_state(acs_json_path: str, cert_dir: str) -> None:
    """清空 acs.json 中的 AIC，并删除 cert_dir 中的证书/密钥文件。

    Args:
        acs_json_path: acs.json 文件路径。
        cert_dir: 证书目录路径。
    """
    if os.path.isdir(cert_dir):
        for pattern in ("*.pem", "*.key"):
            for f in glob.glob(os.path.join(cert_dir, pattern)):
                try:
                    os.remove(f)
                except OSError:
                    pass
        try:
            os.remove(os.path.join(cert_dir, "eab.json"))
        except OSError:
            pass

    if not os.path.isfile(acs_json_path):
        return

    try:
        with open(acs_json_path, encoding="utf-8") as f:
            payload = json.load(f)
        payload["aic"] = ""
        with open(acs_json_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=False)
            f.write("\n")
    except (json.JSONDecodeError, OSError):
        pass
