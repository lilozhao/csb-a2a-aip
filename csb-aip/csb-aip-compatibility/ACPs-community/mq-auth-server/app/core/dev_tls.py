"""Development TLS path helpers and runtime validation."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.core.config import Settings


@dataclass(frozen=True)
class DevTlsLayout:
    """Filesystem layout for development TLS materials."""

    server_cert_file: Path
    server_key_file: Path
    ca_cert_file: Path
    ca_key_file: Path
    client_cert_file: Path
    client_key_file: Path


def build_dev_tls_layout(settings: Settings) -> DevTlsLayout:
    """Derive the development TLS file layout from runtime settings."""

    cert_dir = settings.tls_cert_file.parent
    return DevTlsLayout(
        server_cert_file=settings.tls_cert_file,
        server_key_file=settings.tls_key_file,
        ca_cert_file=settings.tls_ca_cert_file,
        ca_key_file=settings.tls_ca_cert_file.with_name("acps-root-ca-key.pem"),
        client_cert_file=cert_dir / "client.pem",
        client_key_file=cert_dir / "client.key",
    )


def ensure_runtime_tls_assets(settings: Settings) -> None:
    """Ensure runtime TLS materials exist before the service starts.

    In development mode, missing certificates must be prepared ahead of time via
    the shared development PKI entrypoint.
    In testing / production modes, certificate files must already exist.

    Args:
        settings: Runtime settings holding TLS file locations.

    Raises:
        FileNotFoundError: When required TLS materials are missing.
    """

    required_files = [
        settings.tls_cert_file,
        settings.tls_key_file,
        settings.tls_ca_cert_file,
    ]
    missing_files = [path for path in required_files if not path.exists()]
    if not missing_files:
        return

    missing_display = ", ".join(str(path) for path in missing_files)
    if settings.app_env != "development":
        raise FileNotFoundError(
            f"TLS certificate files are required when APP_ENV is not development: {missing_display}"
        )

    raise FileNotFoundError(
        "Development TLS files are missing. "
        f"Run `just prep certs` to sync them from ../acps-infra/dev-infra/dev-cert.sh: {missing_display}"
    )
