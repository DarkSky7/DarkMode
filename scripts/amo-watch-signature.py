#!/usr/bin/env python3
"""Wait for AMO to sign a DarkMode release, then have CI commit the signed xpi.

WHY THIS EXISTS (2026-11-05): uploading a version to the listed channel does NOT
give you a signed file. The version sits at `file.status = unreviewed` with
`signed_date = null`, and the file URL serves the UNSIGNED build — a zip with no
META-INF at all, which Firefox/Zen refuse to install. The signature appears only
once Mozilla approves the version, on their schedule, not ours.

The repo already has the sanctioned path for getting the artifact in:
`.github/workflows/sync-signed.yml` fetches the public signed package and commits
it into `signed/`. But it only triggers on a tag push or manual dispatch, and a
tag that was pushed while the version was still unreviewed will have synced the
PREVIOUS public version (observed: pushing tag v1.0.14 synced 1.0.7). So this
watcher polls for the signature and then DISPATCHES that workflow, leaving CI as
the single writer of signed/.

Design: SILENT when there is nothing to report (cron delivers only non-empty
stdout), one notification per version (marker file), and exit 0 either way — a
watchdog that crashes must not page anyone.

Usage:  amo-watch-signature.py [version]
Env:    AMO_ENV  path to the file holding AMO_JWT_ISSUER / AMO_JWT_SECRET
        GH_PAT   path to a repo PAT able to dispatch workflows
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADDON = "darkmode@landis.cc"
REPO = "DarkSky7/DarkMode"
WORKFLOW = "sync-signed.yml"
BASE = "https://addons.mozilla.org/api/v5"
STATE = r"F:\tmp\msi\darkmode\state"
AMO_ENV = os.environ.get("AMO_ENV") or r"C:\Users\Mike2\.ssh\amo-transcript-first-guard.env"
GH_PAT = os.environ.get("GH_PAT") or r"C:\Users\Mike2\.ssh\DarkMode_PAT"


def load_env(path):
    out = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        return out
    return out


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make_jwt(iss, sec):
    now = int(time.time())
    signing = (b64u(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode()) + "." +
               b64u(json.dumps({"iss": iss, "jti": uuid.uuid4().hex, "iat": now, "exp": now + 300},
                               separators=(",", ":")).encode()))
    return signing + "." + b64u(hmac.new(sec.encode(), signing.encode(), hashlib.sha256).digest())


def amo_version(ver, jwt):
    req = urllib.request.Request(BASE + "/addons/addon/%s/versions/%s/" % (ADDON, ver))
    req.add_header("Authorization", "JWT " + jwt)
    req.add_header("User-Agent", "darkmode-release/1.0")
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def dispatch(ver):
    tok = ""
    try:
        tok = open(GH_PAT, encoding="utf-8").read().strip()
    except OSError:
        pass
    if not tok:
        return False, "no PAT at %s" % GH_PAT
    url = "https://api.github.com/repos/%s/actions/workflows/%s/dispatches" % (REPO, WORKFLOW)
    body = json.dumps({"ref": "main", "inputs": {"version": ver}}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", "Bearer " + tok)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "darkmode-release/1.0")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return (r.status in (201, 204)), "HTTP %s" % r.status
    except urllib.error.HTTPError as e:
        return False, "HTTP %s %s" % (e.code, e.read().decode(errors="replace")[:200])
    except Exception as exc:                       # noqa: BLE001
        return False, exc.__class__.__name__


def main():
    ver = sys.argv[1] if len(sys.argv) > 1 else json.load(
        open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))["version"]
    marker = os.path.join(STATE, "amo-signed-%s" % ver)
    if os.path.isfile(marker):
        return 0                                    # already reported -> stay silent
    env = load_env(AMO_ENV)
    if "AMO_JWT_ISSUER" not in env or "AMO_JWT_SECRET" not in env:
        print("DarkMode %s: cannot check AMO signature - no credentials at %s" % (ver, AMO_ENV))
        return 0
    jwt = make_jwt(env["AMO_JWT_ISSUER"], env["AMO_JWT_SECRET"])
    try:
        d = amo_version(ver, jwt)
    except urllib.error.HTTPError as e:
        print("DarkMode %s: AMO check failed HTTP %s" % (ver, e.code))
        return 0
    except Exception as exc:                        # noqa: BLE001 - network flake is not an alert
        print("DarkMode %s: AMO check failed (%s)" % (ver, exc.__class__.__name__))
        return 0
    f = d.get("file") or {}
    if not f.get("signed_date"):
        return 0                                    # awaiting review -> silent
    ok, detail = dispatch(ver)
    os.makedirs(STATE, exist_ok=True)
    open(marker, "w").write("%s signed_date=%s file_status=%s dispatch=%s\n"
                            % (time.strftime("%Y-%m-%dT%H:%M:%S"), f.get("signed_date"),
                               f.get("status"), detail))
    state = "dispatched sync-signed.yml (%s)" % detail if ok else "DISPATCH FAILED (%s)" % detail
    print("DarkMode %s is SIGNED on AMO (signed_date %s, file %s). %s. The signed xpi lands in "
          "signed/darkmode-%s.xpi via CI; install it in Zen from about:addons -> gear -> "
          "Install Add-on From File." % (ver, f.get("signed_date"), f.get("status"), state, ver))
    return 0


if __name__ == "__main__":
    sys.exit(main())
