"""mTLS health probe used by container health checks and smoke tests."""

from __future__ import annotations

import argparse
import os
import ssl
from pathlib import Path

import httpx

from app.core.config import Settings
from app.core.dev_tls import build_dev_tls_layout


def resolve_probe_tls_files() -> tuple[Path, Path, Path]:
    """Resolve client cert, key, and CA files for the health probe."""

    app_env = os.environ.get("APP_ENV", "development")
    ca_cert_file = Path(
        os.environ.get("HEALTHCHECK_TLS_CA_CERT_FILE") or os.environ.get("TLS_CA_CERT_FILE", "certs/acps-root-ca.pem")
    )
    explicit_cert_file = os.environ.get("HEALTHCHECK_TLS_CERT_FILE")
    explicit_key_file = os.environ.get("HEALTHCHECK_TLS_KEY_FILE")
    if explicit_cert_file and explicit_key_file:
        return Path(explicit_cert_file), Path(explicit_key_file), ca_cert_file

    if app_env == "development":
        settings = Settings.model_validate(
            {
                "APP_ENV": app_env,
                "RABBITMQ_MGMT_PASS": os.environ.get("RABBITMQ_MGMT_PASS", "dev-healthcheck-placeholder"),
                "TLS_CERT_FILE": os.environ.get("TLS_CERT_FILE", "certs/server.pem"),
                "TLS_KEY_FILE": os.environ.get("TLS_KEY_FILE", "certs/server.key"),
                "TLS_CA_CERT_FILE": str(ca_cert_file),
            }
        )
        layout = build_dev_tls_layout(settings)
        return layout.client_cert_file, layout.client_key_file, ca_cert_file

    raise FileNotFoundError(
        "HEALTHCHECK_TLS_CERT_FILE and HEALTHCHECK_TLS_KEY_FILE are required when APP_ENV is not development"
    )


def build_probe_ssl_context() -> ssl.SSLContext:
    """Build the client TLS context used by health probes."""

    cert_file, key_file, ca_cert_file = resolve_probe_tls_files()
    for path in (cert_file, key_file, ca_cert_file):
        if not path.exists():
            raise FileNotFoundError(f"health probe TLS file not found: {path}")

    ssl_context = ssl.create_default_context(
        purpose=ssl.Purpose.SERVER_AUTH,
        cafile=str(ca_cert_file),
    )
    ssl_context.load_cert_chain(certfile=str(cert_file), keyfile=str(key_file))
    ssl_context.minimum_version = ssl.TLSVersion.TLSv1_3
    return ssl_context


def probe_url(url: str, *, timeout: float) -> int:
    """Probe the target URL using mTLS and return the HTTP status code."""

    ssl_context = build_probe_ssl_context()
    with httpx.Client(
        verify=ssl_context,
        timeout=timeout,
    ) as client:
        response = client.get(url)
        return int(response.status_code)


def main() -> None:
    parser = argparse.ArgumentParser(description="mTLS health probe")
    parser.add_argument(
        "--url",
        default="https://localhost:9007/health",
        help="Target health endpoint URL",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=5.0,
        help="Request timeout in seconds",
    )
    args = parser.parse_args()

    status = probe_url(args.url, timeout=args.timeout)
    if status != 200:
        raise SystemExit(f"Health probe returned unexpected status: {status}")


if __name__ == "__main__":
    main()
