"""Promote an account to administrator.

No endpoint can set a role, by design: `role` is absent from every request
schema, so privilege escalation through a request body is impossible rather
than merely guarded. Promotion is therefore an out-of-band operation, and this
script is the supported way to perform it.

    cd backend
    .venv/Scripts/python.exe scripts/promote_admin.py you@example.com

It reads the same DATABASE_URL as the application, so it promotes the account
in whichever database the app is actually configured to use - which is the
mistake the raw SQL in the README invites, where it is easy to edit the local
SQLite file while the app is talking to Postgres.

The promoted user must obtain a new access token (sign out and back in, or let
the client refresh) before the change appears in their token. Authorisation
itself re-reads the role from the database on every request, so a **demotion**
takes effect immediately.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Run as a script from anywhere, without an editable install.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.models import User  # noqa: E402
from app.schemas import normalise_email  # noqa: E402

VALID_ROLES = ("admin", "customer")


def main() -> int:
    parser = argparse.ArgumentParser(description="Promote (or demote) an account.")
    parser.add_argument("email", help="The account's email address.")
    parser.add_argument(
        "--role",
        default="admin",
        choices=VALID_ROLES,
        help="Role to set. Defaults to admin; pass --role customer to demote.",
    )
    args = parser.parse_args()

    # The same lowercasing the API applies on the way in, so an address typed
    # with different capitalisation still finds the account.
    email = normalise_email(args.email)

    with SessionLocal() as db:
        user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        if user is None:
            print(f"No account found for {email!r}.", file=sys.stderr)
            return 1

        if user.role == args.role:
            print(f"{email} is already {args.role}. Nothing to do.")
            return 0

        previous = user.role
        user.role = args.role
        db.commit()

    print(f"{email}: {previous} -> {args.role}")
    if args.role == "admin":
        print("They must sign out and back in for the new role to appear in their token.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
