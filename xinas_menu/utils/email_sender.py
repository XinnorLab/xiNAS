"""email_sender.py — send email via SMTP using xiNAS config."""
from __future__ import annotations

import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

_log = logging.getLogger(__name__)


def send_email(
    subject: str,
    body: str,
    config: dict,
    html: bool = False,
) -> tuple[bool, str]:
    """Send an email using SMTP settings from config["email"].

    Args:
        subject: Email subject line.
        body: Plain text (or HTML if html=True) body.
        config: Full xiNAS config dict (reads config["email"]).
        html: If True, send as HTML; otherwise plain text.

    Returns:
        (ok, error_message) — ok=True on success, error_message="" on success.
    """
    email_cfg = config.get("email", {})
    if not email_cfg.get("enabled"):
        return False, "Email not enabled in settings"

    host = email_cfg.get("smtp_host", "")
    port = int(email_cfg.get("smtp_port", 587))
    use_tls = email_cfg.get("smtp_tls", True)
    user = email_cfg.get("smtp_user", "")
    password = email_cfg.get("smtp_password", "")
    from_addr = email_cfg.get("from_addr", user)
    to_addrs = email_cfg.get("to_addrs", [])

    if not host:
        return False, "SMTP host not configured"
    if not to_addrs:
        return False, "No recipient addresses configured"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(to_addrs)
    content_type = "html" if html else "plain"
    msg.attach(MIMEText(body, content_type))

    try:
        if use_tls:
            smtp = smtplib.SMTP(host, port, timeout=30)
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
        else:
            smtp = smtplib.SMTP(host, port, timeout=30)
            smtp.ehlo()

        if user and password:
            smtp.login(user, password)

        smtp.sendmail(from_addr, to_addrs, msg.as_string())
        smtp.quit()
        _log.info("Email sent to %s: %s", to_addrs, subject)
        return True, ""
    except Exception as exc:
        _log.warning("Email send failed: %s", exc)
        return False, str(exc)
