"""Launcher for the bundled gagent Node.js CLI.

Resolves the user's Node.js (>=18), locates the bundled CLI JavaScript
shipped inside this package, and execs it, forwarding all arguments,
standard streams, and the process exit code.
"""

import os
import shutil
import subprocess
import sys

_NODE_MISSING_MSG = (
    "gagent requires Node.js >=18 to run, but no 'node' executable was found "
    "on your PATH.\nInstall Node.js from https://nodejs.org/ and try again.\n"
)


def _bundle_path() -> str:
    """Return the absolute path to the bundled CLI JavaScript file."""
    # Prefer importlib.resources (handles zip/installed layouts); fall back
    # to __file__-relative resolution for maximum compatibility.
    try:
        from importlib.resources import files

        resource = files(__package__).joinpath("_bundle", "gagent.cli.js")
        # as_file would copy from a zip; our wheel installs unpacked, so the
        # str path is a real filesystem path. Guard for the unpacked case.
        path = str(resource)
        if os.path.isfile(path):
            return path
    except Exception:
        pass

    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "_bundle", "gagent.cli.js")


def _node_major_version(node: str) -> int:
    """Return the major version of the given node executable, or -1 on error."""
    try:
        out = subprocess.run(
            [node, "--version"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except Exception:
        return -1
    # Expected form: "v18.17.0"
    ver = out.lstrip("v").split(".", 1)[0]
    try:
        return int(ver)
    except ValueError:
        return -1


def main() -> "int | None":
    node = shutil.which("node")
    if not node:
        sys.stderr.write(_NODE_MISSING_MSG)
        sys.exit(1)

    major = _node_major_version(node)
    if major == -1:
        sys.stderr.write(
            "gagent could not determine your Node.js version. "
            "Node.js >=18 is required (https://nodejs.org/).\n"
        )
        sys.exit(1)
    if major < 18:
        sys.stderr.write(
            "gagent requires Node.js >=18, but found major version "
            f"{major}.\nUpgrade Node.js from https://nodejs.org/ and try again.\n"
        )
        sys.exit(1)

    bundle = _bundle_path()
    if not os.path.isfile(bundle):
        sys.stderr.write(
            f"gagent bundled CLI not found at {bundle}. "
            "The package may be corrupted; try reinstalling.\n"
        )
        sys.exit(1)

    cmd = [node, bundle, *sys.argv[1:]]

    # On POSIX, exec replaces this process so signals/stdio pass through
    # cleanly. On Windows, os.execv has surprising console semantics, so use
    # subprocess and propagate the exit code instead.
    if os.name == "posix":
        os.execv(node, cmd)
    else:
        completed = subprocess.run(cmd)
        sys.exit(completed.returncode)


if __name__ == "__main__":
    main()
