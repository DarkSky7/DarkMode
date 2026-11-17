#!/usr/bin/env python3
"""Close the DarkMode release loop without the AMO web UI.

    python scripts/amo-release.py auth         # read-only: does the key work
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
import re
import sys
import time
import urllib.error
import urllib.request
import base64
import uuid
import zipfile

# line ending for multipart bodies (never write \\r\\n inline: it gets mangled)
_CRLF = chr(13) + chr(10)
API = "https://addons.mozilla.org/api/v5"
GUID = "darkmode@landis.cc"
SLUG = "darkmode-for-resistant-sites"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
ENV_PATH = os.environ.get('AMO_ENV') or 'C:/Users/Mike2/.ssh/amo-darkmode.env'

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


def post_with_retry(url, data, headers, attempts=3):
    """AMO throttles repeated uploads (429 "Expected available in N seconds").

    Honor the advertised wait instead of failing a release on it.
    """
    import re
    for i in range(attempts):
        status, raw = http(url, data=data, headers=headers)
        if status != 429 or i == attempts - 1:
            return status, raw
        m = re.search(rb"available in (\d+)", raw)
        wait = (int(m.group(1)) + 2) if m else 20
        print("throttled by AMO — waiting %ds" % wait)
        time.sleep(wait)
    return status, raw


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


def cmd_auth():
    """Read-only proof the key works: lists the add-ons it may publish to."""
    env = load_env()
    issuer = (env.get("AMO_JWT_ISSUER") or env.get("AMO_JWT_ISSUE")
              or env.get("AMO_API_KEY") or env.get("JWT_ISSUER"))
    secret = (env.get("AMO_JWT_SECRET") or env.get("AMO_API_SECRET")
              or env.get("JWT_SECRET"))
    if not issuer or not secret:
        print("no credentials in %s" % ENV_PATH)
        return 2
    status, data = get_json(API + "/addons/addon/?lang=en-US",
                            headers={"Authorization": "JWT " + jwt(issuer, secret)})
    print("authenticated GET /addons/addon/ -> http %s" % status)
    if status != 200:
        print("the key pair is wrong or revoked: %s" % json.dumps(data)[:300])
        return 1
    print("add-ons this key can publish to: %s" % data.get("count"))
    for a in data.get("results", []):
        print("  %-32s %-32s %s" % (a.get("slug"), a.get("guid"), a.get("status")))
    print("\nNOTE: an AMO key is ACCOUNT-wide, not per add-on.")
    return 0


def cmd_upload():
    env = load_env()
    # accepted spellings — the file is hand-written and `AMO_JWT_ISSUER` once
    # arrived as `AMO_JWT_ISSUE`, which silently disabled the whole path
    issuer = (env.get("AMO_JWT_ISSUER") or env.get("AMO_JWT_ISSUE")
              or env.get("AMO_API_KEY") or env.get("JWT_ISSUER"))
    secret = (env.get("AMO_JWT_SECRET") or env.get("AMO_API_SECRET")
              or env.get("JWT_SECRET"))
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

    # 1. upload the file. AMO requires `channel` alongside the file:
    #    "listed" = public on AMO, "unlisted" = self-distributed (signed only).
    channel = env.get("AMO_CHANNEL", "listed")
    boundary = "----dm" + uuid.uuid4().hex
    with open(path, "rb") as fh:
        blob = fh.read()
    kind = "Content-Disposition: form-data; name="
    body = (
        ("--" + boundary + _CRLF + kind + "\"channel\"" + _CRLF + _CRLF
         + channel + _CRLF).encode()
        + ("--" + boundary + _CRLF + kind + "\"upload\"; filename=\""
           + os.path.basename(path) + "\"" + _CRLF
           + "Content-Type: application/octet-stream" + _CRLF + _CRLF).encode()
        + blob
        + (_CRLF + "--" + boundary + "--" + _CRLF).encode()
    )

    headers = dict(auth)
    headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
    status, raw = post_with_retry(API + "/addons/upload/", body, headers)
    if status not in (200, 201, 202):
        print("upload failed: http %s %s" % (status, raw[:400].decode("utf-8", "replace")))
        return 1
    up = json.loads(raw)
    uid = up.get("uuid")
    print("uploaded %s (%d bytes) uuid=%s" % (os.path.basename(path), len(blob), uid))

    # 2. wait for server-side validation. AMO answers the POST immediately with
    #    valid=false/processed=false; those are placeholders until it has
    #    actually run the validator. Judging `valid` from the POST response
    #    rejects every good file.
    info = up
    for _ in range(40):
        status, info = get_json("%s/addons/upload/%s/" % (API, uid), headers=auth)
        if status == 200 and info.get("processed"):
            break
        time.sleep(2)
    else:
        print("validation did not finish; check the devhub")
        return 1

    if not info.get("valid"):
        print("AMO rejected the file:")
        print(json.dumps(info.get("validation", {}), indent=2)[:1500])
        return 1
    print("validation: passed")

    # 3. create the version. The collection endpoint takes the upload uuid;
    #    POSTing to /versions/<ver>/ answers 405 — the per-version URL is
    #    read/patch only. Proven by OPTIONS: the list exposes a POST action.
    payload_body = json.dumps({"upload": uid}).encode()
    h2 = dict(auth)
    h2["Content-Type"] = "application/json"
    status, raw = post_with_retry("%s/addons/addon/%s/versions/" % (API, GUID),
                                 payload_body, h2)
    if status == 409:
        print("AMO already has version %s — nothing to publish." % ver)
        print("bump \"version\" in manifest.json (+ popup.js VERSION), re-run scripts/package.py")
        return cmd_verify()
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


def _bump_version(part, dry):
    """Bump every place the version is written: manifest.json, popup.js and content.js.

    They drifted twice already: the manifest said 1.0.16 while the popup still
    reported 1.0.15, and content.js sat on 1.0.14 for three releases (it is what
    the popup prints in some paths, so "am I running the new build?" becomes
    unanswerable from the UI). One function touches all three, then re-reads
    them and refuses to continue if any did not take.
    """
    mp = os.path.join(ROOT, "manifest.json")
    raw = open(mp, encoding="utf-8").read()
    cur = json.loads(raw)["version"]
    major, minor, patch = (cur.split(".") + ["0", "0"])[:3]
    if part == "major":
        major, minor, patch = str(int(major) + 1), "0", "0"
    elif part == "minor":
        minor, patch = str(int(minor) + 1), "0"
    else:
        patch = str(int(patch) + 1)
    new = "%s.%s.%s" % (major, minor, patch)
    if dry:
        print("would bump %s -> %s" % (cur, new))
        return cur, new
    open(mp, "w", encoding="utf-8").write(
        raw.replace('"version": "%s"' % cur, '"version": "%s"' % new, 1))
    # popup.js and content.js both carry `const VERSION = '<x>'`; regex, not a
    # literal replace, so a stale value gets corrected instead of silently kept.
    for fn in ("popup.js", "content.js"):
        p = os.path.join(ROOT, fn)
        src = open(p, encoding="utf-8").read()
        dst = re.sub(r"const VERSION = '[^']*'", "const VERSION = '%s'" % new, src, count=1)
        if dst == src:
            print("ERROR: no VERSION line in %s" % fn)
            return cur, new
        open(p, "w", encoding="utf-8").write(dst)
    for fn in ("manifest.json", "popup.js", "content.js"):
        if new not in open(os.path.join(ROOT, fn), encoding="utf-8").read():
            print("ERROR: %s does not carry version %s after bump" % (fn, new))
            sys.exit(3)
    print("bumped %s -> %s (manifest.json + popup.js + content.js)" % (cur, new))
    return cur, new


def cmd_release():
    """One command for the whole loop: bump, package, upload, verify, install, commit."""
    import subprocess
    args = sys.argv[2:]
    part = "patch"
    if "--bump" in args:
        i = args.index("--bump")
        if i + 1 < len(args):
            part = args[i + 1]
    if part not in ("major", "minor", "patch"):
        print("--bump takes major | minor | patch")
        return 2
    dry = "--dry-run" in args

    status, data = get_json("%s/addons/addon/%s/versions/?page_size=1" % (API, GUID))
    newest = data["results"][0]["version"] if (data and data.get("results")) else "?"
    print("newest on AMO: %s" % newest)

    cur, new = _bump_version(part, dry)
    if dry:
        print("would run  : scripts/package.py")
        print("would upload: dist/DarkMode-%s-firefox.xpi" % new)
        print("would verify then install into every Firefox/Zen profile")
        print("would commit: release %s" % new)
        return 0

    rc = subprocess.call([sys.executable, os.path.join(ROOT, "scripts", "package.py")])
    if rc != 0:
        print("packaging failed -- version files are already bumped to %s, fix and re-run" % new)
        return rc
    rc = cmd_upload()
    if rc != 0:
        return rc
    rc = cmd_install()
    subprocess.call(["git", "-C", ROOT, "add", "-A"])
    subprocess.call(["git", "-C", ROOT, "commit", "-m", "release: %s" % new])
    print("\nrelease %s done" % new)
    return rc


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    fn = {"auth": cmd_auth, "check": cmd_check, "verify": cmd_verify,
          "install": cmd_install, "upload": cmd_upload,
          "release": cmd_release}.get(cmd)
    if not fn:
        print(__doc__)
        return 2
    return fn()


if __name__ == "__main__":
    sys.exit(main())
