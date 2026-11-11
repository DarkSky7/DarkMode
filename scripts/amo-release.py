#!/usr/bin/env python3
"""Close the DarkMode release loop without the AMO web UI.

    python scripts/amo-release.py check        # what AMO has, and is it signed
    python scripts/amo-release.py verify       # live payload vs the local build
    python scripts/amo-release.py install      # pull the signed file, put it in
                                               # every Firefox/Zen profile
    python scripts/amo-release.py upload       # needs the API key (see below)

Credentials (only `upload` needs them) go in ~/.ssh/amo-darkmode.env:

    AMO_JWT_ISSUER=user:12345678:123
    AMO_JWT_SECRET=deadbeef...
    AMO_ADDON=darkmode@landis.cc

Create the key at https://addons.mozilla.org/en-US/developers/addon/api/key/
It is shown once. Unlisted/listed does not matter; the key is per account.

Why this exists: the loop was "build -> click through devhub -> hunt the right
file -> wait -> ask a human whether it landed". Uploading the Chromium zip to
AMO instead of the Firefox xpi fails with '"background/service_worker" must be
paired with "background/scripts"', and re-uploading a version that already
exists fails with "Version X already exists" — both are one line here.
"""
import glob
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
import base64
import uuid
import zipfile

API = "https://addons.mozilla.org/api/v5"
GUID = "darkmode@landis.cc"
SLUG = "darkmode-for-resistant-sites"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
ENV_PATH = os.path.expanduser("~/.ssh/amo-darkmode.env")

PROFILE_GLOBS = [
    os.path.expandvars(r"%APPDATA%\Mozilla\Firefox\Profiles\*"),
    os.path.expandvars(r"%APPDATA%\zen\Profiles\*"),
]


# ── tiny HTTP ────────────────────────────────────────────────────────────────
def http(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def get_json(url, headers=None):
    status, body = http(url, headers=headers)
    return status, (json.loads(body) if body else None)


# ── AMO auth ─────────────────────────────────────────────────────────────────
def load_env():
    env = {}
    if os.path.exists(ENV_PATH):
        for line in open(ENV_PATH, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def jwt(issuer, secret):
    """HS256 JWT — no pyjwt dependency, AMO only verifies the signature."""
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    now = int(time.time())
    payload = b64url(json.dumps(
        {"iss": issuer, "jti": uuid.uuid4().hex, "iat": now, "exp": now + 300},
        separators=(",", ":")).encode())
    signing_input = (header + "." + payload).encode()
    sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return header + "." + payload + "." + b64url(sig)


# ── local artifact ───────────────────────────────────────────────────────────
def local_xpi():
    """The Firefox-flavoured artifact for the version in manifest.json."""
    manifest = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))
    ver = manifest["version"]
    for name in ("DarkMode-%s-firefox.xpi" % ver, "DarkMode-%s.xpi" % ver):
        p = os.path.join(DIST, name)
        if os.path.exists(p):
            return ver, p
    return ver, None


def payload(path):
    """Everything in the archive except the signature.

    manifest.json is compared PARSED, not byte-for-byte: AMO re-serializes it
    while signing (which is why its copy shows the em dash as \\u2014 and the
    local one does not). Every other file has to match exactly.
    """
    with zipfile.ZipFile(path) as z:
        out = {n: z.read(n) for n in z.namelist() if not n.startswith("META-INF")}
    if "manifest.json" in out:
        out["manifest.json"] = json.dumps(
            json.loads(out["manifest.json"]), sort_keys=True).encode()
    return out


def is_signed(path):
    with zipfile.ZipFile(path) as z:
        return any(n.endswith("cose.sig") for n in z.namelist())


# ── commands ─────────────────────────────────────────────────────────────────
def cmd_check():
    status, data = get_json("%s/addons/addon/%s/versions/?page_size=10" % (API, GUID))
    if status != 200 or not data:
        print("AMO returned %s for %s" % (status, GUID))
        return 1
    ver, path = local_xpi()
    print("%d versions on AMO" % data["count"])
    for v in data["results"]:
        f = v["file"]
        print("  %-8s %-8s %-8s %s" % (v["version"], v["channel"], f["status"], f["created"][:16]))
    newest = data["results"][0]["version"] if data["results"] else None
    print("\nnewest on AMO : %s" % newest)
    print("local manifest: %s" % ver)
    if newest == ver:
        print("=> AMO already has this version; nothing to upload.")
    elif newest and ver > newest:
        print("=> %s is unpublished." % ver)
    return 0


def cmd_verify():
    ver, path = local_xpi()
    if not path:
        print("no local artifact for %s (run scripts/package.py)" % ver)
        return 1
    status, data = get_json("%s/addons/addon/%s/versions/?page_size=20" % (API, GUID))
    match = next((v for v in data["results"] if v["version"] == ver), None)
    if not match:
        print("%s is not on AMO yet" % ver)
        return 1
    url = match["file"]["url"]
    status, body = http(url)
    tmp = os.path.join(os.environ.get("TEMP", "."), "amo-%s.xpi" % ver)
    open(tmp, "wb").write(body)
    live, mine = payload(tmp), payload(path)
    same = live == mine
    print("AMO file      : %s (%d bytes, signed=%s)" % (url.rsplit("/", 1)[-1], len(body), is_signed(tmp)))
    print("local build   : %s (%d bytes)" % (os.path.basename(path), os.path.getsize(path)))
    print("payload files : %d live / %d local" % (len(live), len(mine)))
    if same:
        print("=> byte-identical payload (AMO re-serializes manifest.json, so the archives differ)")
        return 0
    diff = sorted(set(live) ^ set(mine)) or [n for n in live if live[n] != mine.get(n)]
    print("=> DIFFERS in: %s" % diff)
    return 1


def cmd_install():
    ver, path = local_xpi()
    status, data = get_json("%s/addons/addon/%s/versions/?page_size=20" % (API, GUID))
    match = next((v for v in data["results"] if v["version"] == ver), None)
    if not match:
        print("%s is not on AMO — nothing signed to install" % ver)
        return 1
    status, body = http(match["file"]["url"])
    if not body or not body.startswith(b"PK"):
        print("download failed (http %s)" % status)
        return 1
    tmp = os.path.join(os.environ.get("TEMP", "."), "amo-%s.xpi" % ver)
    open(tmp, "wb").write(body)
    if not is_signed(tmp):
        print("downloaded file is NOT signed — refusing to install")
        return 1
    installed, locked = [], []
    for pattern in PROFILE_GLOBS:
        for prof in glob.glob(pattern):
            ext_dir = os.path.join(prof, "extensions")
            if not os.path.isdir(ext_dir):
                continue
            target = os.path.join(ext_dir, GUID + ".xpi")
            try:
                with open(tmp, "rb") as src, open(target, "wb") as dst:
                    dst.write(src.read())
                installed.append((prof, ver))
            except (PermissionError, OSError):
                locked.append(prof)
    for prof, v in installed:
        print("installed %s -> %s" % (v, os.path.basename(os.path.dirname(prof)) + "/" + os.path.basename(prof)))
    for prof in locked:
        print("LOCKED (browser running) %s" % prof)
    if not installed and not locked:
        print("no Firefox/Zen profiles found under %APPDATA%")
    if locked:
        print("\nclose those browsers and re-run install, or let them update from AMO on their own.")
    if installed:
        print("\nrestart the browser(s) to load the new version.")
    return 0


def cmd_upload():
    env = load_env()
    issuer, secret = env.get("AMO_JWT_ISSUER"), env.get("AMO_JWT_SECRET")
    if not issuer or not secret:
        print("no credentials at %s" % ENV_PATH)
        print("create one at https://addons.mozilla.org/en-US/developers/addon/api/key/")
        print("then write:")
        print("  AMO_JWT_ISSUER=user:NNNNN:NNN")
        print("  AMO_JWT_SECRET=...")
        return 2
    ver, path = local_xpi()
    if not path:
        print("no local artifact for %s (run scripts/package.py)" % ver)
        return 1
    with zipfile.ZipFile(path) as z:
        bg = json.loads(z.read("manifest.json")).get("background", {})
    if "service_worker" in bg:
        print("refusing to upload: this artifact uses background.service_worker (Chromium flavour)")
        return 1

    token = jwt(issuer, secret)
    auth = {"Authorization": "JWT " + token}

    # 1. upload the file
    boundary = "----dm" + uuid.uuid4().hex
    with open(path, "rb") as fh:
        blob = fh.read()
    body = (
        ("--%s\r\nContent-Disposition: form-data; name=\"upload\"; filename=\"%s\"\r\n"
         "Content-Type: application/octet-stream\r\n\r\n" % (boundary, os.path.basename(path))).encode()
        + blob + ("\r\n--%s--\r\n" % boundary).encode()
    )
    headers = dict(auth)
    headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
    status, raw = http(API + "/addons/upload/", data=body, headers=headers)
    if status not in (200, 201, 202):
        print("upload failed: http %s %s" % (status, raw[:400].decode("utf-8", "replace")))
        return 1
    up = json.loads(raw)
    uid = up.get("uuid")
    print("uploaded %s (%d bytes) uuid=%s valid=%s" % (os.path.basename(path), len(blob), uid, up.get("valid")))
    if not up.get("valid"):
        print("AMO rejected the file:")
        print(json.dumps(up.get("validation", {}), indent=2)[:1500])
        return 1

    # 2. wait for server-side validation
    for _ in range(30):
        status, info = get_json("%s/addons/upload/%s/" % (API, uid), headers=auth)
        if status == 200 and info.get("processed"):
            break
        time.sleep(2)
    else:
        print("validation did not finish; check the devhub")
        return 1

    # 3. create the version
    payload_body = json.dumps({"upload": uid}).encode()
    h2 = dict(auth)
    h2["Content-Type"] = "application/json"
    status, raw = http("%s/addons/addon/%s/versions/%s/" % (API, GUID, ver),
                       data=payload_body, headers=h2)
    if status not in (200, 201, 202):
        print("version create failed: http %s %s" % (status, raw[:400].decode("utf-8", "replace")))
        return 1
    print("submitted %s — AMO signs listed versions on approval" % ver)

    # 4. wait for the signed file to appear
    for i in range(60):
        status, data = get_json("%s/addons/addon/%s/versions/?page_size=20" % (API, GUID))
        hit = next((v for v in (data or {}).get("results", []) if v["version"] == ver), None)
        if hit:
            print("version %s is %s" % (ver, hit["file"]["status"]))
            if hit["file"]["status"] in ("public", "unreviewed"):
                return cmd_verify()
        time.sleep(10)
    print("still waiting on AMO; re-run `verify` later")
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    fn = {"check": cmd_check, "verify": cmd_verify, "install": cmd_install, "upload": cmd_upload}.get(cmd)
    if not fn:
        print(__doc__)
        return 2
    return fn()


if __name__ == "__main__":
    sys.exit(main())
