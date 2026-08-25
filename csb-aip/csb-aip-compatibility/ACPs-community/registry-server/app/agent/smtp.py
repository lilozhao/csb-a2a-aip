import re
import secrets
import smtplib
import string
from datetime import timedelta
from email.message import EmailMessage
from textwrap import dedent
from typing import Any, cast

from fastapi import Request
from sqlalchemy import select

from app.account.model import Role, RoleType, User
from app.agent.model import EmailCode
from app.core.config import settings
from app.core.db_session import get_sync_session
from app.utils.utils import get_beijing_time


def have_config() -> bool:
    """
    检测是否有邮箱配置
    """
    return bool(settings.smtp_server and settings.email_address and settings.email_password)


def is_email(email: str) -> bool:
    """简单的邮箱格式验证"""
    pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
    return bool(re.match(pattern, email))


def send_mail(to_email: str, subject: str, html_content: str) -> None:
    """
    发送邮件
    """
    if not have_config():
        return
    # 创建邮件
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.email_address
    msg["To"] = to_email
    # 设置 HTML 内容
    msg.set_content(html_content, subtype="html")
    # 发送邮件（使用SSL）
    try:
        with smtplib.SMTP_SSL(settings.smtp_server, int(settings.smtp_port)) as server:
            server.login(settings.email_address, settings.email_password)
            server.send_message(msg)
    except Exception as err:
        raise RuntimeError("发送失败") from err


async def send_need_review_mail(agent_id: str, agent_name: str, base_url: str) -> None:
    """
    智能体提交审核时，发送邮件通知

    Agrs:
        agent_id: 智能体ID
        agent_name: 智能体名称
        base_url: 网址
    """
    if not have_config():
        return
    if not agent_name:
        raise RuntimeError("没有智能体名称")
    users: list[User] | None = None
    # 获取管理员用户列表
    with get_sync_session() as db:
        # 使用 db 执行查询
        stmt = (
            select(User)
            .join(cast("Any", User.roles))
            .where(cast("Any", Role.name) == RoleType.STAFF)
            .where(cast("Any", User.email).is_not(None))
        )
        result = db.execute(stmt)
        users = list(result.scalars().all()) or None
        # with 块结束时会自动 commit 并关闭 session

    if users:
        # 构造跳转链接（替换成你的实际前端地址）
        review_url = f"{base_url}/#/agent-approval/detail?agentId={agent_id}"

        # 邮件主题
        subject = f"【审核通知】{agent_name} 智能体待审核"

        # 构造HTML内容
        html_content = dedent(
            f"""
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
            </head>
            <body
                style="
                    font-family: Arial, sans-serif;
                    line-height: 1.6;
                    color: #333;
                "
            >
                <div
                    style="
                        max-width: 600px;
                        margin: 0 auto;
                        padding: 20px;
                    "
                >
                    <h2 style="color: #4CAF50;">智能体审核通知</h2>

                    <p>您好，</p>

                    <p>您有一个智能体需要审核：</p>

                    <div
                        style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;"
                    >
                        <p style="margin: 5px 0;"><strong>智能体名称：</strong> {agent_name}</p>
                        <p style="margin: 5px 0;">
                            <strong>状态：</strong>
                            <span style="color: #ff9800;">待审核</span>
                        </p>
                    </div>

                    <p>请点击下方链接前往智能体注册页面进行审核：</p>

                    <p style="text-align: center; margin: 25px 0;">
                        <a
                            href="{review_url}"
                            style="
                                background-color: #4CAF50;
                                color: white;
                                padding: 12px 30px;
                                text-decoration: none;
                                border-radius: 4px;
                                display: inline-block;
                                font-weight: bold;
                            "
                        >
                            前往智能体注册页审核
                        </a>
                    </p>

                    <p>
                        如果按钮无法点击，请复制以下链接到浏览器打开：<br>
                        <a href="{review_url}" style="color: #4CAF50;">{review_url}</a>
                    </p>

                    <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">

                    <p style="color: #999; font-size: 12px;">
                        此邮件由系统自动发送，请勿直接回复。<br>
                        如有疑问，请联系管理员。
                    </p>
                </div>
            </body>
            </html>
            """
        ).strip()
        # 发送邮件
        for user in users:
            if user.email:
                send_mail(user.email, subject, html_content)


def get_frontend_url(request: Request) -> str:
    """
    从请求中获取前端基础URL
    """
    # 方式1：从请求头获取 Origin（推荐）
    origin = request.headers.get("origin")
    if origin:
        return origin

    # 方式2：从 Referer 获取
    referer = request.headers.get("referer")
    if referer:
        # 提取协议和域名部分
        from urllib.parse import urlparse

        parsed = urlparse(referer)
        return f"{parsed.scheme}://{parsed.netloc}"

    # 方式3：使用配置的默认值
    return getattr(settings, "FRONTEND_URL", "https://ioa.pub")


def send_code(email: str) -> bool:
    """发送验证码"""
    if not have_config():
        return False
    if not email:
        return False
    # 单位s, 有效时长
    ttl_seconds = 300
    ttl_minutes = ttl_seconds // 60
    # 生成验证码
    charset = string.ascii_uppercase + string.digits  # 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    # 随机生成4个字符
    code = "".join(secrets.choice(charset) for _ in range(4))
    with get_sync_session() as db:
        # 插入数据库
        now = get_beijing_time()
        # 3. 设置过期时间为5分钟后
        expires_at = now + timedelta(seconds=ttl_seconds)
        email_code = EmailCode(email=email, code=code, created_at=now, expires_at=expires_at)
        db.add(email_code)
        db.commit()
        db.refresh(email_code)

    # 发送验证
    # 构造HTML内容
    html_content = dedent(
        f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>邮箱验证码</title>
        </head>
        <body
            style="
                font-family: Arial, sans-serif;
                line-height: 1.6;
                color: #333;
                margin: 0;
                padding: 0;
                background-color: #f9f9f9;
            "
        >
            <div
                style="
                    max-width: 600px;
                    margin: 20px auto;
                    padding: 20px;
                    background-color: #ffffff;
                    border-radius: 8px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
                "
            >
                <div style="text-align: center; margin-bottom: 25px;">
                    <h2 style="color: #4CAF50; margin: 0; font-weight: 600;">📧 邮箱验证码</h2>
                    <p style="color: #777; font-size: 14px; margin-top: 8px;">请使用下方验证码完成操作</p>
                </div>

                <p style="font-size: 15px; margin: 0 0 12px 0;">您好，</p>

                <p style="font-size: 15px; margin: 0 0 12px 0;">
                    您正在<span style="font-weight: 600;">ACPs智能体注册</span>进行敏感操作，
                    请使用以下验证码完成身份验证：
                </p>

                <div
                    style="
                        background-color: #f0f9f0;
                        padding: 20px 16px;
                        margin: 20px 0;
                        text-align: center;
                        border-radius: 10px;
                    "
                >
                    <p style="margin: 0 0 8px 0; font-size: 14px; letter-spacing: 1px; color: #2c6e2c;">您的验证码是</p>
                    <p
                        style="
                            font-size: 38px;
                            font-weight: bold;
                            letter-spacing: 6px;
                            color: #2e7d32;
                            margin: 10px 0;
                            font-family: monospace;
                        "
                    >
                        {code}
                    </p>
                    <p style="margin: 12px 0 0 0; font-size: 13px; color: #5e5e5e;">
                        该验证码 <strong>{ttl_minutes}分钟</strong> 内有效，请勿泄露给他人。
                    </p>
                </div>

                <div
                    style="
                        background-color: #f5f7fa;
                        padding: 12px 16px;
                        border-radius: 8px;
                        margin: 20px 0;
                        font-size: 14px;
                        border: 1px solid #e2e8f0;
                    "
                >
                    <p style="margin: 0 0 6px 0;">🔐 安全提示：</p>
                    <ul style="margin: 0; padding-left: 20px;">
                        <li>验证码仅用于验证您的身份，请不要告知任何人（包括客服）。</li>
                        <li>如果您没有进行此操作，请忽略本邮件，并检查账号安全。</li>
                    </ul>
                </div>
            </div>
        </body>
        </html>
        """
    ).strip()
    send_mail(email, "【验证码通知】", html_content)
    return True


def send_password(email: str, password: str) -> bool:
    # 构造HTML内容
    html_content = dedent(
        f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>重置密码</title>
        </head>
        <body
            style="
                font-family: Arial, sans-serif;
                line-height: 1.6;
                color: #333;
                margin: 0;
                padding: 0;
                background-color: #f9f9f9;
            "
        >
            <div
                style="
                    max-width: 600px;
                    margin: 20px auto;
                    padding: 20px;
                    background-color: #ffffff;
                    border-radius: 8px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
                "
            >
                <div style="text-align: center; margin-bottom: 25px;">
                    <h2 style="color: #4CAF50; margin: 0; font-weight: 600;">🔐 重置密码</h2>
                    <p style="color: #777; font-size: 14px; margin-top: 8px;">您的新密码已生成</p>
                </div>

                <p style="font-size: 15px; margin: 0 0 12px 0;">您好，</p>

                <p style="font-size: 15px; margin: 0 0 12px 0;">
                    您已成功重置<span style="font-weight: 600;">ACPs智能体</span>的密码，以下是您的新密码：
                </p>

                <div
                    style="
                        background-color: #f0f9f0;
                        padding: 20px 16px;
                        margin: 20px 0;
                        text-align: center;
                        border-radius: 10px;
                    "
                >
                    <p style="margin: 0 0 8px 0; font-size: 14px; letter-spacing: 1px; color: #2c6e2c;">您的新密码</p>
                    <p
                        style="
                            font-size: 38px;
                            font-weight: bold;
                            letter-spacing: 6px;
                            color: #2e7d32;
                            margin: 10px 0;
                            font-family: monospace;
                        "
                    >
                        {password}
                    </p>
                    <p style="margin: 12px 0 0 0; font-size: 13px; color: #5e5e5e;">
                        请使用此密码登录，建议登录后尽快修改密码。
                    </p>
                </div>

                <div
                    style="
                        background-color: #f5f7fa;
                        padding: 12px 16px;
                        border-radius: 8px;
                        margin: 20px 0;
                        font-size: 14px;
                        border: 1px solid #e2e8f0;
                    "
                >
                    <p style="margin: 0 0 6px 0;">🔐 安全提示：</p>
                    <ul style="margin: 0; padding-left: 20px;">
                        <li>请妥善保管您的密码，不要告知任何人（包括客服）。</li>
                        <li>建议登录后立即修改为便于记忆的密码。</li>
                        <li>如果您没有申请重置密码，请立即联系平台客服。</li>
                    </ul>
                </div>
            </div>
        </body>
        </html>
        """
    ).strip()
    send_mail(email, "【重置密码通知】", html_content)
    return True
