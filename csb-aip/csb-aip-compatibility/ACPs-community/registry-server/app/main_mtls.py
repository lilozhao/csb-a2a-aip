"""Provider 侧本体证书 mTLS 平面入口。"""

import ssl

import uvicorn

from app.core.config import settings
from app.core.peer_cert import PeerCertH11Protocol
from app.main import create_mtls_app

app = create_mtls_app()


def _build_server_ssl_context() -> ssl.SSLContext:
    """构建 9002 mTLS listener 所需的服务端 TLS 上下文。"""
    if settings.mtls_cert_file is None or settings.mtls_key_file is None or settings.mtls_ca_cert_file is None:
        raise RuntimeError(
            "REGISTRY_SERVER_MTLS_CERT_FILE, REGISTRY_SERVER_MTLS_KEY_FILE and "
            "REGISTRY_SERVER_MTLS_CA_CERT_FILE are required for the mTLS listener"
        )

    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain(
        certfile=str(settings.mtls_cert_file),
        keyfile=str(settings.mtls_key_file),
    )
    ssl_context.load_verify_locations(cafile=str(settings.mtls_ca_cert_file))
    ssl_context.verify_mode = ssl.CERT_REQUIRED
    ssl_context.minimum_version = ssl.TLSVersion.TLSv1_3
    return ssl_context


def run() -> None:
    """启动 9002 mTLS listener。"""
    config = uvicorn.Config(
        app=app,
        host=settings.uvicorn_host,
        port=settings.mtls_port,
        log_level=settings.uvicorn_log_level,
        reload=settings.uvicorn_reload,
        http=PeerCertH11Protocol,
        proxy_headers=False,
        lifespan="on",
    )
    config.load()
    config.ssl = _build_server_ssl_context()
    uvicorn.Server(config).run()


if __name__ == "__main__":
    run()
