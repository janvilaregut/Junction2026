#!/usr/bin/env python3
"""E2: build a seeded copy of the base tree with a documented set of known defects.

The script copies the base tree, injects 30 fake secrets, 9 known-vulnerable
NuGet package versions, 30 insecure C# snippets and 20 code clones, and writes
a ground-truth JSON describing every injected item (file, 1-based line range,
category, expected detectors). Everything is driven by one fixed random seed,
so two runs with the same base tree and seed produce byte-identical output.

All secret values are randomly generated to match the public token formats.
They are not real credentials and are not documentation example keys. The
ground truth stores only a SHA-256 of each value; the plain values are written
to a side file inside the (git-ignored) corpus directory so that tool outputs
can be redacted before anything is shared (GitHub push protection would
otherwise block a push that contains correctly-formatted fake tokens).

Usage (from the repository root, with the main .venv which has tree-sitter):
    .venv/bin/python experiments/tools/seed_defects.py \
        --base corpus/tools/refs/base --out corpus/tools/seeded \
        --truth out/tools/seeded/ground_truth.json \
        --values corpus/tools/seeded-secret-values.json [--verify-osv]
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import random
import re
import shutil
import string
import urllib.request
import zlib
from pathlib import Path

import tree_sitter_c_sharp as tscs
from tree_sitter import Language, Parser

SEED = 20261114
LANG = Language(tscs.language())
PARSER = Parser(LANG)

# ----------------------------------------------------------------------------
# Secret generators (formats from the public token specifications)
# ----------------------------------------------------------------------------
B62 = string.digits + string.ascii_uppercase + string.ascii_lowercase
ALNUM = string.ascii_letters + string.digits


def _rand(rng: random.Random, alphabet: str, n: int) -> str:
    return "".join(rng.choice(alphabet) for _ in range(n))


def _b62(num: int, width: int) -> str:
    out = ""
    while num:
        num, r = divmod(num, 62)
        out = B62[r] + out
    return out.rjust(width, "0")


def gen_aws(rng):
    key_id = "AKIA" + _rand(rng, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)
    secret = _rand(rng, ALNUM + "/+", 40)
    return {"key_id": key_id, "secret": secret}


def gen_github(rng):
    # Classic PAT: ghp_ + 30 random base62 + 6-char base62 CRC32 checksum.
    body = _rand(rng, ALNUM, 30)
    return {"token": "ghp_" + body + _b62(zlib.crc32(body.encode()), 6)}


def gen_slack(rng):
    return {"token": "xoxb-" + _rand(rng, string.digits, 11) + "-" + _rand(rng, string.digits, 13)
            + "-" + _rand(rng, ALNUM, 24)}


def gen_stripe(rng):
    return {"token": "sk" + "_live_" + _rand(rng, ALNUM, rng.choice([24, 99]))}


def gen_jwt(rng):
    def b64u(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")
    header = b64u(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = {"sub": _rand(rng, string.hexdigits.lower()[:16], 24), "name": "svc-" + _rand(rng, string.ascii_lowercase, 8),
              "role": "admin", "iat": rng.randint(1_600_000_000, 1_750_000_000)}
    payload = b64u(json.dumps(claims, separators=(",", ":")).encode())
    sig = b64u(bytes(rng.getrandbits(8) for _ in range(32)))
    return {"token": f"{header}.{payload}.{sig}"}


def gen_connstr(rng):
    pw = _rand(rng, ALNUM, 16) + _rand(rng, "._-", 1) + _rand(rng, ALNUM, 5)
    host = "sql-" + _rand(rng, string.ascii_lowercase, 6) + ".internal"
    db = rng.choice(["Orders", "Billing", "Inventory", "Telemetry"])
    user = "svc_" + _rand(rng, string.ascii_lowercase, 5)
    return {"value": f"Server=tcp:{host},1433;Database={db};User ID={user};Password={pw};Encrypt=True;",
            "password": pw}


def gen_azure(rng):
    account = _rand(rng, string.ascii_lowercase + string.digits, 12)
    key = base64.b64encode(bytes(rng.getrandbits(8) for _ in range(64))).decode()
    return {"value": f"DefaultEndpointsProtocol=https;AccountName={account};AccountKey={key};EndpointSuffix=core.windows.net",
            "key": key}


_SMALL_PRIMES = [p for p in range(3, 2000) if all(p % q for q in range(2, int(p ** 0.5) + 1))]


def _probable_prime(n: int, rng) -> bool:
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(24):
        x = pow(rng.randrange(2, n - 2), d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits: int, rng) -> int:
    while True:
        c = rng.getrandbits(bits) | (3 << (bits - 2)) | 1
        if _probable_prime(c, rng):
            return c


def _der_len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(raw)]) + raw


def _der_int(v: int) -> bytes:
    raw = v.to_bytes(max(1, (v.bit_length() + 8) // 8), "big")
    return b"\x02" + _der_len(len(raw)) + raw


def gen_pem(rng, bits: int = 2048):
    """A structurally valid, freshly generated (seeded) PKCS#1 RSA private key."""
    e = 65537
    while True:
        p, q = _prime(bits // 2, rng), _prime(bits // 2, rng)
        phi = (p - 1) * (q - 1)
        if p != q and math.gcd(e, phi) == 1:
            break
    d = pow(e, -1, phi)
    body = b"".join(_der_int(x) for x in (0, p * q, e, d, p, q, d % (p - 1), d % (q - 1), pow(q, -1, p)))
    der = b"\x30" + _der_len(len(body)) + body
    b64 = base64.b64encode(der).decode()
    kind = "RSA " + "PRIVATE KEY"
    return {"lines": [f"-----BEGIN {kind}-----", *[b64[i:i + 64] for i in range(0, len(b64), 64)],
                      f"-----END {kind}-----"]}


SECRET_FORMATS = {  # format -> (count, generator, expected detectors by documented default rules)
    "aws": (4, gen_aws, ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy", "semgrep-secrets"]),
    "github_pat": (4, gen_github, ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy"]),
    "slack": (4, gen_slack, ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy", "semgrep-secrets"]),
    "stripe": (4, gen_stripe, ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy", "semgrep-secrets"]),
    "private_key_pem": (3, gen_pem, ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy", "semgrep-secrets"]),
    "jwt": (4, gen_jwt, ["gitleaks", "betterleaks", "trufflehog", "detect-secrets", "trivy"]),
    "connstring_password": (4, gen_connstr, ["gitleaks", "betterleaks", "trufflehog", "detect-secrets"]),
    "azure_storage": (3, gen_azure, ["betterleaks", "trufflehog", "detect-secrets"]),
}

# ----------------------------------------------------------------------------
# Vulnerable NuGet packages (verified against https://api.osv.dev/v1/query)
# ----------------------------------------------------------------------------
VULN_PACKAGES = [  # (manifest kind, package, version, advisories at verification time)
    ("cpm-props", "Newtonsoft.Json", "12.0.1", ["GHSA-5crp-9r3c-p9vr"]),
    ("cpm-props", "System.Text.Encodings.Web", "4.5.0", ["GHSA-ghhp-997w-qr28"]),
    ("cpm-props", "System.Net.Http", "4.3.0", ["GHSA-7jgj-8wvc-jh57"]),
    ("csproj-version", "Microsoft.Data.SqlClient", "1.1.0", ["GHSA-8g2p-5pqh-5jmc", "GHSA-98g6-xh36-x2p7"]),
    ("csproj-version", "System.Text.RegularExpressions", "4.3.0", ["GHSA-cmhx-cq75-c4mj"]),
    ("csproj-version", "System.IdentityModel.Tokens.Jwt", "5.6.0", ["GHSA-59j7-ghrg-fj52"]),
    ("packages.config", "SharpZipLib", "1.2.0", ["GHSA-m22m-h4rf-pwq3", "GHSA-mm6g-mmq6-53ff"]),
    ("packages.config", "log4net", "2.0.9", ["GHSA-2cwj-8chv-9pp9", "GHSA-4f7c-pmjv-c25w"]),
    ("packages.config", "YamlDotNet", "4.3.1", ["GHSA-rpch-cqj9-h65r"]),
]
DEP_DETECTORS = ["osv-scanner", "trivy", "grype"]

# ----------------------------------------------------------------------------
# Insecure snippets. "@@" marks sink lines; {N} is a unique numeric suffix;
# {PW} is a random hard-coded password. Indentation unit is 4 spaces.
# ----------------------------------------------------------------------------
SAST = {
    "binaryformatter": ("CWE-502", ["semgrep-csharp", "codeql"], [
        (["System.IO", "System.Runtime.Serialization.Formatters.Binary"], """
internal static object RestoreSnapshot{N}(Stream input)
{
    var formatter = new BinaryFormatter();@@
    return formatter.Deserialize(input);@@
}"""),
        (["System.IO", "System.Runtime.Serialization.Formatters.Binary"], """
internal static T ReadCachedState{N}<T>(byte[] payload)
{
    using (var ms = new MemoryStream(payload))
    {
        var bf = new BinaryFormatter();@@
        return (T)bf.Deserialize(ms);@@
    }
}"""),
        (["System.IO", "System.Runtime.Serialization", "System.Runtime.Serialization.Formatters.Binary"], """
internal static object LoadSession{N}(string path)
{
    IFormatter formatter = new BinaryFormatter();@@
    using (FileStream fs = File.OpenRead(path))@@
    {@@
        return formatter.Deserialize(fs);@@
    }
}"""),
    ]),
    "weak_hash": ("CWE-328", ["codeql"], [
        (["System.Security.Cryptography", "System.Text"], """
internal static string HashPassword{N}(string password)
{
    using (var md5 = MD5.Create())@@
    {@@
        byte[] digest = md5.ComputeHash(Encoding.UTF8.GetBytes(password));@@
        return System.Convert.ToBase64String(digest);
    }
}"""),
        (["System.Security.Cryptography", "System.Text"], """
internal static byte[] ComputeApiSignature{N}(string secret, string body)
{
    var sha1 = SHA1.Create();@@
    return sha1.ComputeHash(Encoding.UTF8.GetBytes(secret + body));@@
}"""),
        (["System.Security.Cryptography", "System.Text"], """
internal static bool VerifyPasswordHash{N}(string password, byte[] expectedHash)
{
    using (var sha = new SHA1CryptoServiceProvider())@@
    {@@
        byte[] actual = sha.ComputeHash(Encoding.UTF8.GetBytes(password));@@
        return System.Linq.Enumerable.SequenceEqual(actual, expectedHash);
    }
}"""),
    ]),
    "weak_cipher": ("CWE-327", ["semgrep-csharp", "codeql"], [
        (["System.Security.Cryptography"], """
internal static byte[] EncryptToken{N}(byte[] plain, byte[] key, byte[] iv)
{
    using (var des = DES.Create())@@
    {@@
        des.Key = key;@@
        des.IV = iv;
        using (var enc = des.CreateEncryptor())
        {
            return enc.TransformFinalBlock(plain, 0, plain.Length);
        }
    }
}"""),
        (["System.Security.Cryptography"], """
internal static byte[] ProtectPayload{N}(byte[] data, byte[] key)
{
    var rc2 = RC2.Create();@@
    rc2.Key = key;@@
    rc2.GenerateIV();
    return rc2.CreateEncryptor().TransformFinalBlock(data, 0, data.Length);
}"""),
        (["System.Security.Cryptography"], """
internal static ICryptoTransform CreateLegacyDecryptor{N}(byte[] key, byte[] iv)
{
    var provider = new DESCryptoServiceProvider();@@
    return provider.CreateDecryptor(key, iv);@@
}"""),
    ]),
    "sql_concat": ("CWE-89", ["semgrep-csharp", "codeql"], [
        (["System.Data.SqlClient"], """
internal static int CountOrders{N}(SqlConnection connection, string customerName)
{
    var command = new SqlCommand("SELECT COUNT(*) FROM Orders WHERE Customer = '" + customerName + "'", connection);@@
    return (int)command.ExecuteScalar();@@
}"""),
        (["System.Data.SqlClient"], """
internal static void DeleteUser{N}(SqlConnection connection, string userId)
{
    using (SqlCommand cmd = connection.CreateCommand())
    {
        cmd.CommandText = "DELETE FROM Users WHERE Id = " + userId;@@
        cmd.ExecuteNonQuery();@@
    }
}"""),
        (["System.Data"], """
internal static IDataReader FindProducts{N}(IDbConnection connection, string category, string sortColumn)
{
    IDbCommand command = connection.CreateCommand();
    string sql = "SELECT * FROM Products WHERE Category = '" + category + "' ORDER BY " + sortColumn;@@
    command.CommandText = sql;@@
    return command.ExecuteReader();@@
}"""),
    ]),
    "process_start": ("CWE-78", ["codeql"], [
        (["System.Diagnostics"], """
internal static void OpenReport{N}(string fileName)
{
    Process.Start("cmd.exe", "/c type " + fileName);@@
}"""),
        (["System.Diagnostics"], """
internal static string RunGit{N}(string arguments)
{
    var psi = new ProcessStartInfo("bash", "-c \\"git " + arguments + "\\"")@@
    {
        RedirectStandardOutput = true,
        UseShellExecute = false,
    };
    using (var process = Process.Start(psi))@@
    {
        return process.StandardOutput.ReadToEnd();
    }
}"""),
        (["System.Diagnostics"], """
internal static void ConvertImage{N}(string inputPath, string options)
{
    var process = new Process();
    process.StartInfo.FileName = "/usr/bin/convert";
    process.StartInfo.Arguments = inputPath + " " + options;@@
    process.Start();@@
}"""),
    ]),
    "xml_dtd": ("CWE-611", ["semgrep-csharp", "codeql"], [
        (["System.IO", "System.Xml"], """
internal static XmlReader OpenConfig{N}(Stream stream)
{
    var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Parse, XmlResolver = new XmlUrlResolver() };@@
    return XmlReader.Create(stream, settings);@@
}"""),
        (["System.Xml"], """
internal static XmlDocument LoadManifest{N}(string xml)
{
    var doc = new XmlDocument();@@
    doc.XmlResolver = new XmlUrlResolver();@@
    doc.LoadXml(xml);@@
    return doc;
}"""),
        (["System.IO", "System.Xml"], """
internal static string ReadTitle{N}(Stream input)
{
    var reader = new XmlTextReader(input);@@
    reader.DtdProcessing = DtdProcessing.Parse;@@
    while (reader.Read())
    {
        if (reader.NodeType == XmlNodeType.Element && reader.Name == "title")
        {
            return reader.ReadElementContentAsString();
        }
    }

    return string.Empty;
}"""),
    ]),
    "insecure_random": ("CWE-338", ["semgrep-csharp", "codeql"], [
        (["System", "System.Globalization"], """
internal static string CreateResetToken{N}()
{
    var random = new Random();@@
    return random.Next(100000, 999999).ToString(CultureInfo.InvariantCulture);@@
}"""),
        (["System"], """
internal static byte[] GenerateSessionKey{N}()
{
    var key = new byte[32];
    new Random().NextBytes(key);@@
    return key;
}"""),
        (["System"], """
internal static string GenerateApiKey{N}(int length)
{
    const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var rng = new Random();@@
    var chars = new char[length];
    for (int i = 0; i < chars.Length; i++)
    {
        chars[i] = alphabet[rng.Next(alphabet.Length)];@@
    }

    return new string(chars);
}"""),
    ]),
    "hardcoded_password": ("CWE-798", ["codeql"], [
        ([], """
internal static bool IsAdmin{N}(string user, string password)
{
    return user == "admin" && password == "{PW}";@@
}"""),
        (["System"], """
internal static bool CheckMaintenancePassword{N}(string input)
{
    if (string.Equals(input, "{PW}", StringComparison.Ordinal))@@
    {
        return true;
    }

    return false;
}"""),
        ([], """
internal static bool Authenticate{N}(string userName, string password)
{
    const string ServicePassword = "{PW}";@@
    return userName == "svc-backup" && password.Equals(ServicePassword);@@
}"""),
    ]),
    "cert_validation_disabled": ("CWE-295", ["codeql"], [
        (["System.Net"], """
internal static void TrustAllCertificates{N}()
{
    ServicePointManager.ServerCertificateValidationCallback = (sender, certificate, chain, errors) => true;@@
}"""),
        (["System.Net.Http"], """
internal static HttpClient CreateInsecureClient{N}()
{
    var handler = new HttpClientHandler();
    handler.ServerCertificateCustomValidationCallback = (message, cert, chain, errors) => true;@@
    return new HttpClient(handler);
}"""),
        (["System.Net.Http"], """
internal static HttpClient CreateTelemetryClient{N}()
{
    var handler = new HttpClientHandler
    {
        ServerCertificateCustomValidationCallback = delegate { return true; },@@
    };
    return new HttpClient(handler);
}"""),
    ]),
    "path_traversal": ("CWE-22", ["semgrep-csharp", "codeql"], [
        (["System.IO"], """
internal static string ReadUserFile{N}(string fileName)
{
    string path = Path.Combine("/var/app/uploads", fileName);@@
    return File.ReadAllText(path);@@
}"""),
        (["System.IO"], """
internal static void DeleteAttachment{N}(string root, string attachmentName)
{
    File.Delete(Path.Combine(root, attachmentName));@@
}"""),
        (["System.IO"], """
internal static Stream OpenExport{N}(string exportName)
{
    var fullPath = Path.Combine(Directory.GetCurrentDirectory(), "exports", exportName);@@
    return new FileStream(fullPath, FileMode.Open, FileAccess.Read);@@
}"""),
    ]),
}
DUP_DETECTORS = ["cpd-100", "cpd-50", "jscpd-100", "jscpd-50"]

# ----------------------------------------------------------------------------
# File helpers (preserve BOM and line endings)
# ----------------------------------------------------------------------------


class SourceFile:
    def __init__(self, path: Path):
        raw = path.read_bytes()
        self.bom = raw.startswith(b"\xef\xbb\xbf")
        text = raw.decode("utf-8-sig")
        self.eol = "\r\n" if "\r\n" in text else "\n"
        self.lines = text.replace("\r\n", "\n").split("\n")
        self.path = path

    def text(self) -> str:
        return "\n".join(self.lines)

    def save(self):
        data = self.eol.join(self.lines)
        self.path.write_bytes((b"\xef\xbb\xbf" if self.bom else b"") + data.encode("utf-8"))


def parse(text: str):
    return PARSER.parse(text.encode("utf-8"))


def walk(node):
    stack = [node]
    while stack:
        n = stack.pop()
        yield n
        stack.extend(reversed(n.children))


def class_anchor(sf: SourceFile):
    """Row (0-based) of the first class body '{' that sits alone on its line, and its indent."""
    tree = parse(sf.text())
    for n in walk(tree.root_node):
        if n.type == "class_declaration":
            body = n.child_by_field_name("body")
            if body is None:
                continue
            brace = body.children[0]
            row = brace.start_point[0]
            if brace.type == "{" and sf.lines[row].strip() == "{":
                indent = sf.lines[row][: len(sf.lines[row]) - len(sf.lines[row].lstrip())]
                return row, indent
    return None


def using_anchor(sf: SourceFile):
    """Row (0-based) where new top-level using directives can be inserted, plus the existing set."""
    tree = parse(sf.text())
    last, first_decl, existing = None, None, set()
    for c in tree.root_node.children:
        if c.type == "using_directive":
            last = c.end_point[0]
            existing.add(re.sub(r"\s+", " ", sf.lines[c.start_point[0]].strip()))
        elif c.type not in ("comment", "extern_alias_directive") and first_decl is None:
            first_decl = c.start_point[0]
    row = last + 1 if last is not None else (first_decl if first_decl is not None else 0)
    return row, existing


NOINDENT = "\x00"


def insert_block(sf: SourceFile, block: list[str], usings: list[str]):
    """Insert usings (top level) and a member block after the class '{'. Returns first block row (1-based)."""
    if usings:
        row, existing = using_anchor(sf)
        new = [f"using {u};" for u in usings if f"using {u};" not in existing]
        sf.lines[row:row] = new
    anchor = class_anchor(sf)
    assert anchor is not None, sf.path
    row, indent = anchor
    member = indent + "    "
    # lines starting with NOINDENT are continuation lines of a verbatim string: keep them flush-left
    lines = [ln[1:] if ln.startswith(NOINDENT) else ((member + ln) if ln else "") for ln in block] + [""]
    sf.lines[row + 1:row + 1] = lines
    return row + 2  # 1-based line number of the first inserted line


def has_preprocessor_if(text: str) -> bool:
    return re.search(r"^\s*#\s*if\b", text, re.M) is not None


def leaf_tokens(node):
    return [n for n in walk(node) if n.child_count == 0 and n.type != "comment"]


# ----------------------------------------------------------------------------
# Clone construction
# ----------------------------------------------------------------------------
DECL_PARENTS = {"parameter", "variable_declarator", "foreach_statement", "catch_declaration",
                "single_variable_designation"}


def method_candidates(root: Path, files: list[Path]):
    out = []
    for f in files:
        sf = SourceFile(f)
        tree = parse(sf.text())
        for n in walk(tree.root_node):
            if n.type != "method_declaration":
                continue
            body = n.child_by_field_name("body")
            if body is None or body.type != "block":
                continue
            s, e = n.start_point[0], n.end_point[0]
            if not (12 <= e - s + 1 <= 45):
                continue
            toks = leaf_tokens(n)
            if not (110 <= len(toks) <= 450):
                continue
            # start the clone at the first line of the declaration (skip attributes/doc comments)
            out.append({"file": f, "start": s, "end": e, "node_range": (n.start_byte, n.end_byte),
                        "tokens": len(toks)})
    return out


def method_text(sf: SourceFile, start: int, end: int) -> list[str]:
    lines = sf.lines[start:end + 1]
    ind = min((len(l) - len(l.lstrip()) for l in lines if l.strip()), default=0)
    return [l[ind:] if l.strip() else "" for l in lines]


def rename_identifiers(lines: list[str], rng) -> tuple[list[str], dict]:
    text = "\n".join(lines)
    tree = parse("class __C__ {\n" + text + "\n}")
    declared = []
    for n in walk(tree.root_node):
        if n.type == "method_declaration" and n.child_by_field_name("name") is not None:
            declared.append(n.child_by_field_name("name").text.decode())
        if n.type in DECL_PARENTS:
            nm = n.child_by_field_name("name") if n.type != "single_variable_designation" else n
            if nm is None and n.type == "foreach_statement":
                nm = n.child_by_field_name("left")
            if nm is not None and nm.type == "identifier":
                declared.append(nm.text.decode())
    seen, mapping = set(), {}
    for d in declared:
        if d in seen or d.startswith("_"):
            continue
        seen.add(d)
        mapping[d] = d + rng.choice(["Alt", "Local", "Copy", "Value", "2", "Tmp"])
    if not mapping:
        return lines, {}
    # replace identifier tokens (not member names after '.')
    src = ("class __C__ {\n" + text + "\n}").encode()
    edits = []
    for n in walk(tree.root_node):
        if n.type == "identifier" and n.text.decode() in mapping:
            prev = n.prev_sibling
            if prev is not None and prev.type == "." and n.parent is not None and n.parent.type == "member_access_expression":
                continue
            edits.append((n.start_byte, n.end_byte, mapping[n.text.decode()]))
    for s, e, rep in sorted(edits, reverse=True):
        src = src[:s] + rep.encode() + src[e:]
    out = src.decode().split("\n")[1:-1]
    return out, mapping


INSERT_STMTS = [
    'System.Diagnostics.Debug.WriteLine("checkpoint reached");',
    "var startedAt = System.DateTime.UtcNow;",
    "System.Threading.Thread.MemoryBarrier();",
    "_ = System.Environment.TickCount;",
]


def insert_statements(lines: list[str], rng, k: int) -> tuple[list[str], list[int]]:
    tree = parse("class __C__ {\n" + "\n".join(lines) + "\n}")
    body = None
    for n in walk(tree.root_node):
        if n.type == "method_declaration":
            body = n.child_by_field_name("body")
            break
    stmts = [c for c in body.named_children if c.type.endswith("statement") or c.type == "local_declaration_statement"]
    rows = sorted({c.end_point[0] - 1 for c in stmts[:-1]})  # rows in `lines` after which we can insert
    rows = [r for r in rows if lines[r].rstrip().endswith((";", "}"))]
    if not rows:
        rows = [body.children[0].start_point[0] - 1]
    picks = sorted(rng.sample(rows, min(k, len(rows))), reverse=True)
    stmts_text = rng.sample(INSERT_STMTS, len(picks))
    inserted = []
    for r, st in zip(picks, stmts_text):
        nxt = next((l for l in lines[r + 1:] if l.strip()), lines[r])
        ind = nxt[: len(nxt) - len(nxt.lstrip())]
        if nxt.strip() == "}":
            ind = lines[r][: len(lines[r]) - len(lines[r].lstrip())]
        lines = lines[: r + 1] + [ind + st] + lines[r + 1:]
        inserted.append(r + 1)
    return lines, sorted(inserted)


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------


def sha(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


def cs_secret_block(fmt: str, val: dict, rng) -> tuple[list[str], int, int, list[str]]:
    """Return (lines, first secret row, last secret row) relative to block, plus raw values."""
    name = lambda opts: rng.choice(opts)  # noqa: E731
    if fmt == "aws":
        return ([f'private const string {name(["AwsAccessKeyId", "S3AccessKey", "UploadAccessKeyId"])} = "{val["key_id"]}";',
                 f'private const string {name(["AwsSecretAccessKey", "S3SecretKey", "UploadSecretAccessKey"])} = "{val["secret"]}";'],
                0, 1, [val["key_id"], val["secret"]])
    if fmt == "github_pat":
        return ([f'private const string {name(["GitHubToken", "GhToken", "ReleaseBotToken"])} = "{val["token"]}";'], 0, 0, [val["token"]])
    if fmt == "slack":
        return ([f'private const string {name(["SlackBotToken", "SlackToken", "NotifierToken"])} = "{val["token"]}";'], 0, 0, [val["token"]])
    if fmt == "stripe":
        return ([f'private const string {name(["StripeSecretKey", "StripeApiKey", "PaymentsKey"])} = "{val["token"]}";'], 0, 0, [val["token"]])
    if fmt == "jwt":
        return ([f'private const string {name(["ServiceJwt", "BearerToken", "AuthToken"])} = "{val["token"]}";'], 0, 0, [val["token"]])
    if fmt == "connstring_password":
        return ([f'private const string {name(["ConnectionString", "DbConnectionString", "SqlConnection"])} = "{val["value"]}";'], 0, 0, [val["password"]])
    if fmt == "azure_storage":
        return ([f'private const string {name(["StorageConnectionString", "BlobConnection", "AzureStorage"])} = "{val["value"]}";'], 0, 0, [val["key"]])
    if fmt == "private_key_pem":
        pem = val["lines"]
        lines = ([f'private const string {name(["SigningKeyPem", "PrivateKey", "TokenSigningKey"])} = @"{pem[0]}']
                 + [NOINDENT + x for x in pem[1:-1]] + [NOINDENT + pem[-1] + '";'])
        return lines, 0, len(lines) - 1, ["\n".join(pem[1:-1])]
    raise ValueError(fmt)


def config_secret_lines(kind: str, fmt: str, val: dict, rng) -> tuple[list[str], list[str]]:
    """Lines (no trailing comma handling) for one secret in a config file of the given kind."""
    pem_inline = lambda: "\\n".join(val["lines"]) + "\\n"  # noqa: E731
    if kind == "json":
        kv = {
            "aws": [f'"AccessKeyId": "{val.get("key_id")}",', f'"SecretAccessKey": "{val.get("secret")}",'],
            "github_pat": [f'"GitHubToken": "{val.get("token")}",'],
            "slack": [f'"SlackBotToken": "{val.get("token")}",'],
            "stripe": [f'"StripeSecretKey": "{val.get("token")}",'],
            "jwt": [f'"ServiceToken": "{val.get("token")}",'],
            "connstring_password": [f'"DefaultConnection": "{val.get("value")}",'],
            "azure_storage": [f'"StorageAccount": "{val.get("value")}",'],
            "private_key_pem": [f'"PrivateKey": "{pem_inline() if fmt == "private_key_pem" else ""}",'],
        }[fmt]
    elif kind == "xml":
        kv = {
            "aws": [f'<add key="AWSAccessKey" value="{val.get("key_id")}" />', f'<add key="AWSSecretKey" value="{val.get("secret")}" />'],
            "github_pat": [f'<add key="GitHubToken" value="{val.get("token")}" />'],
            "slack": [f'<add key="SlackBotToken" value="{val.get("token")}" />'],
            "stripe": [f'<add key="StripeSecretKey" value="{val.get("token")}" />'],
            "jwt": [f'<add key="ServiceToken" value="{val.get("token")}" />'],
            "connstring_password": [f'<add key="DefaultConnection" value="{val.get("value")}" />'],
            "azure_storage": [f'<add key="StorageConnectionString" value="{val.get("value")}" />'],
            "private_key_pem": ['<add key="SigningKey" value="' + (val["lines"][0] if fmt == "private_key_pem" else "")]
            + (val["lines"][1:-1] if fmt == "private_key_pem" else []) + [(val["lines"][-1] if fmt == "private_key_pem" else "") + '" />'],
        }[fmt]
    elif kind == "yaml":
        kv = {
            "aws": [f"AWS_ACCESS_KEY_ID: {val.get('key_id')}", f"AWS_SECRET_ACCESS_KEY: {val.get('secret')}"],
            "github_pat": [f"GITHUB_TOKEN: {val.get('token')}"],
            "slack": [f"SLACK_BOT_TOKEN: {val.get('token')}"],
            "stripe": [f"STRIPE_SECRET_KEY: {val.get('token')}"],
            "jwt": [f"SERVICE_JWT: {val.get('token')}"],
            "connstring_password": [f"DB_CONNECTION: \"{val.get('value')}\""],
            "azure_storage": [f"AZURE_STORAGE_CONNECTION_STRING: \"{val.get('value')}\""],
            "private_key_pem": ["SIGNING_KEY: |"] + (["  " + l for l in val["lines"]] if fmt == "private_key_pem" else []),
        }[fmt]
    elif kind == "env":
        kv = {
            "aws": [f"AWS_ACCESS_KEY_ID={val.get('key_id')}", f"AWS_SECRET_ACCESS_KEY={val.get('secret')}"],
            "github_pat": [f"GITHUB_TOKEN={val.get('token')}"],
            "slack": [f"SLACK_BOT_TOKEN={val.get('token')}"],
            "stripe": [f"STRIPE_SECRET_KEY={val.get('token')}"],
            "jwt": [f"SERVICE_JWT={val.get('token')}"],
            "connstring_password": [f"DB_CONNECTION=\"{val.get('value')}\""],
            "azure_storage": [f"AZURE_STORAGE_CONNECTION_STRING=\"{val.get('value')}\""],
            "private_key_pem": [f"SIGNING_KEY=\"{pem_inline() if fmt == 'private_key_pem' else ''}\""],
        }[fmt]
    else:
        raise ValueError(kind)
    return kv


CONFIG_FILES = [  # (relative path, kind)
    ("sandbox/Sandbox/appsettings.Production.json", "json"),
    ("benchmark/secrets.json", "json"),
    ("sandbox/SeededLegacyWeb/Web.config", "xml"),
    ("azure-pipelines/release-variables.yml", "yaml"),
    ("tools/deploy.env", "env"),
]


def write_config(path: Path, kind: str, entries: list[list[str]]) -> list[tuple[int, int]]:
    """Write a config file containing the secret entries; return 1-based (start, end) per entry."""
    lines, spans = [], []
    if kind == "json":
        lines += ["{", '  "Logging": { "LogLevel": { "Default": "Information" } },', '  "Secrets": {']
        for e in entries:
            s = len(lines) + 1
            lines += ["    " + x for x in e]
            spans.append((s, len(lines)))
        lines[-1] = lines[-1].rstrip(",")
        lines += ["  },", '  "AllowedHosts": "*"', "}", ""]
    elif kind == "xml":
        lines += ['<?xml version="1.0" encoding="utf-8"?>', "<configuration>", "  <appSettings>",
                  '    <add key="Environment" value="Production" />']
        for e in entries:
            s = len(lines) + 1
            lines += [("    " + x) if i == 0 else x for i, x in enumerate(e)]  # PEM continuation lines flush-left
            spans.append((s, len(lines)))
        lines += ["  </appSettings>", "</configuration>", ""]
    elif kind == "yaml":
        lines += ["variables:", "  BuildConfiguration: Release"]
        for e in entries:
            s = len(lines) + 1
            lines += ["  " + x for x in e]
            spans.append((s, len(lines)))
        lines += [""]
    elif kind == "env":
        lines += ["# deployment settings", "ASPNETCORE_ENVIRONMENT=Production"]
        for e in entries:
            s = len(lines) + 1
            lines += e
            spans.append((s, len(lines)))
        lines += [""]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    return spans


def verify_osv(packages):
    out = {}
    for _, name, version, _adv in packages:
        req = json.dumps({"package": {"name": name, "ecosystem": "NuGet"}, "version": version}).encode()
        r = urllib.request.Request("https://api.osv.dev/v1/query", data=req, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=30) as resp:
            vulns = json.load(resp).get("vulns", [])
        out[f"{name}@{version}"] = sorted(v["id"] for v in vulns)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--truth", required=True, type=Path)
    ap.add_argument("--values", required=True, type=Path, help="side file with plain secret values (keep out of git)")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--verify-osv", action="store_true")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    if args.out.exists():
        shutil.rmtree(args.out)
    shutil.copytree(args.base, args.out)
    root = args.out

    # Candidate C# files: no preprocessor #if, not generated, not Unity bin, with an anchorable class.
    all_cs = sorted(p for p in root.rglob("*.cs") if not p.name.endswith(".g.cs") and "bin" not in p.relative_to(root).parts[:1])
    cands = []
    for p in all_cs:
        sf = SourceFile(p)
        if has_preprocessor_if(sf.text()) or class_anchor(sf) is None:
            continue
        cands.append(p)
    rng.shuffle(cands)

    items, values = [], {}
    rel = lambda p: p.relative_to(root).as_posix()  # noqa: E731

    # ---- clones first (sources must stay untouched) ----
    methods = method_candidates(root, sorted(cands))
    rng.shuffle(methods)
    clone_kinds = ["type1"] * 7 + ["type2"] * 7 + ["type3"] * 6
    used_sources, used_files, clones = set(), set(), []
    for kind in clone_kinds:
        while True:
            m = methods.pop()
            if m["file"] in used_sources:
                continue
            sf = SourceFile(m["file"])
            text = method_text(sf, m["start"], m["end"])
            extra = {}
            if kind == "type2":
                text2, mapping = rename_identifiers(text, rng)
                if len(mapping) < 3:
                    continue
                text, extra = text2, {"renamed": mapping}
            elif kind == "type3":
                text, rows = insert_statements(text, rng, rng.choice([1, 2]))
                extra = {"inserted_rows_in_clone": rows}
            used_sources.add(m["file"])
            clones.append((kind, m, text, extra))
            break
    sources = {m["file"] for _, m, _, _ in clones}
    targets = [p for p in cands if p not in sources]
    tgt_iter = iter(targets)

    for i, (kind, m, text, extra) in enumerate(clones, 1):
        tf = next(tgt_iter)
        sf = SourceFile(tf)
        first = insert_block(sf, text, [])
        sf.save()
        used_files.add(tf)
        items.append({"id": f"DUP-{i:02d}", "category": "duplication", "subtype": kind, "file": rel(tf),
                      "start_line": first, "end_line": first + len(text) - 1,
                      "source_file": rel(m["file"]), "source_start_line": m["start"] + 1, "source_end_line": m["end"] + 1,
                      "source_tokens": m["tokens"], "expected_detectors": DUP_DETECTORS if kind == "type1" else
                      (["cpd-50", "jscpd-50"] if kind == "type3" else []), **extra})

    # ---- secrets ----
    fmts = [f for f, (n, _, _) in SECRET_FORMATS.items() for _ in range(n)]
    rng.shuffle(fmts)
    generated = [(f, SECRET_FORMATS[f][1](rng)) for f in fmts]
    cs_part, cfg_part = generated[:20], generated[20:]
    sec_id = 0
    for fmt, val in cs_part:
        sec_id += 1
        tf = next(tgt_iter)
        sf = SourceFile(tf)
        block, a, b, raw = cs_secret_block(fmt, val, rng)
        first = insert_block(sf, block, [])
        sf.save()
        sid = f"SEC-{sec_id:02d}"
        values[sid] = raw
        items.append({"id": sid, "category": "secret", "subtype": fmt, "file": rel(tf), "carrier": "csharp-literal",
                      "start_line": first + a, "end_line": first + b, "value_sha256": [sha(x) for x in raw],
                      "expected_detectors": SECRET_FORMATS[fmt][2]})
    per_file = {c: [] for c in CONFIG_FILES}
    for j, (fmt, val) in enumerate(cfg_part):
        per_file[CONFIG_FILES[j % len(CONFIG_FILES)]].append((fmt, val))
    for (relpath, kind), entries in per_file.items():
        spans = write_config(root / relpath, kind, [config_secret_lines(kind, f, v, rng) for f, v in entries])
        for (fmt, val), (s, e) in zip(entries, spans):
            sec_id += 1
            sid = f"SEC-{sec_id:02d}"
            raw = {"aws": [val.get("key_id"), val.get("secret")], "private_key_pem": ["\n".join(val.get("lines", [""])[1:-1])],
                   "connstring_password": [val.get("password")], "azure_storage": [val.get("key")]}.get(fmt, [val.get("token")])
            values[sid] = raw
            items.append({"id": sid, "category": "secret", "subtype": fmt, "file": relpath, "carrier": f"config-{kind}",
                          "start_line": s, "end_line": e, "value_sha256": [sha(x) for x in raw],
                          "expected_detectors": SECRET_FORMATS[fmt][2]})

    # ---- insecure snippets ----
    sast_list = [(cat, v) for cat in SAST for v in range(3)]
    rng.shuffle(sast_list)
    for k, (cat, v) in enumerate(sast_list, 1):
        cwe, expected, variants = SAST[cat]
        usings, tpl = variants[v]
        n = rng.randint(10, 99)
        pw = rng.choice(["Adm1n", "Maint", "Svc", "Root"]) + "!" + _rand(rng, ALNUM, 10)
        raw_lines = tpl.strip("\n").replace("{N}", str(n)).replace("{PW}", pw).split("\n")
        sink_rows = [i for i, l in enumerate(raw_lines) if l.endswith("@@")]
        block = [l[:-2] if l.endswith("@@") else l for l in raw_lines]
        tf = next(tgt_iter)
        sf = SourceFile(tf)
        first = insert_block(sf, block, usings)
        sf.save()
        items.append({"id": f"SAST-{k:02d}", "category": "sast", "subtype": cat, "variant": v + 1, "cwe": cwe,
                      "file": rel(tf), "start_line": first + min(sink_rows), "end_line": first + max(sink_rows),
                      "method_start_line": first, "method_end_line": first + len(block) - 1,
                      "expected_detectors": expected})

    # ---- vulnerable packages ----
    dep_items = []
    props = SourceFile(root / "Directory.Packages.props")
    for i, l in enumerate(props.lines):
        if 'Include="Newtonsoft.Json" Version="13.0.3"' in l:
            props.lines[i] = l.replace('Version="13.0.3"', 'Version="12.0.1"')
            dep_items.append(("Newtonsoft.Json", "Directory.Packages.props", i + 1))
    anchor = next(i for i, l in enumerate(props.lines) if 'Include="PolySharp"' in l)
    for off, (name, ver) in enumerate([("System.Text.Encodings.Web", "4.5.0"), ("System.Net.Http", "4.3.0")], 1):
        props.lines.insert(anchor + off, f'    <PackageVersion Include="{name}" Version="{ver}" />')
        dep_items.append((name, "Directory.Packages.props", anchor + off + 1))
    props.save()
    sbx = SourceFile(root / "sandbox/Sandbox/Sandbox.csproj")
    a = next(i for i, l in enumerate(sbx.lines) if 'Include="ZeroFormatter"' in l)
    sbx.lines[a + 1:a + 1] = ['    <PackageReference Include="System.Net.Http" />',
                              '    <PackageReference Include="System.Text.Encodings.Web" />']
    sbx.save()
    legacy = root / "sandbox/SeededLegacyApp/SeededLegacyApp.csproj"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    lines = ['<Project Sdk="Microsoft.NET.Sdk">', "  <PropertyGroup>", "    <OutputType>Exe</OutputType>",
             "    <TargetFramework>net8.0</TargetFramework>", "    <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>",
             "  </PropertyGroup>", "  <ItemGroup>"]
    for kind, name, ver, _ in VULN_PACKAGES:
        if kind == "csproj-version":
            lines.append(f'    <PackageReference Include="{name}" Version="{ver}" />')
            dep_items.append((name, rel(legacy), len(lines)))
    lines += ["  </ItemGroup>", "</Project>", ""]
    legacy.write_text("\n".join(lines), encoding="utf-8")
    pkgcfg = root / "sandbox/SeededLegacyWeb/packages.config"
    pkgcfg.parent.mkdir(parents=True, exist_ok=True)
    lines = ['<?xml version="1.0" encoding="utf-8"?>', "<packages>"]
    for kind, name, ver, _ in VULN_PACKAGES:
        if kind == "packages.config":
            lines.append(f'  <package id="{name}" version="{ver}" targetFramework="net472" />')
            dep_items.append((name, rel(pkgcfg), len(lines)))
    lines += ["</packages>", ""]
    pkgcfg.write_text("\n".join(lines), encoding="utf-8")
    loc = {n: (f, ln) for n, f, ln in dep_items}
    osv = verify_osv(VULN_PACKAGES) if args.verify_osv else None
    for k, (kind, name, ver, adv) in enumerate(VULN_PACKAGES, 1):
        f, ln = loc[name]
        items.append({"id": f"DEP-{k:02d}", "category": "dependency", "subtype": kind, "package": name, "version": ver,
                      "advisories": adv, "osv_verified": (osv or {}).get(f"{name}@{ver}"), "file": f,
                      "start_line": ln, "end_line": ln, "expected_detectors": DEP_DETECTORS})

    truth = {"seed": args.seed, "base": str(args.base), "seeded_root": str(args.out),
             "generator": "experiments/tools/seed_defects.py",
             "matching_rule": "detected if a finding of the same category overlaps [start_line-2, end_line+2] in the same file; "
                              "dependencies: same package (+version) with any advisory, any manifest",
             "counts": {c: sum(1 for i in items if i["category"] == c) for c in ("secret", "dependency", "sast", "duplication")},
             "items": items}
    args.truth.parent.mkdir(parents=True, exist_ok=True)
    args.truth.write_text(json.dumps(truth, indent=2) + "\n")
    args.values.parent.mkdir(parents=True, exist_ok=True)
    args.values.write_text(json.dumps(values, indent=2) + "\n")
    print(json.dumps(truth["counts"]))


if __name__ == "__main__":
    main()
