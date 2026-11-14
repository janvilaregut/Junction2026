"""Security and reliability: secrets (patterns + Shannon entropy), dangerous APIs
mapped to CWE, dependency inventory (for OSV), and reliability anti-patterns."""
from __future__ import annotations

import math
import re
from collections import Counter
from pathlib import Path

from .model import text, line0

SEV = {"critical": 1.0, "high": 0.8, "medium": 0.5, "low": 0.2, "info": 0.0}

SECRET_PATTERNS = [
    ("secret.aws_access_key", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), "critical"),
    ("secret.github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"), "critical"),
    ("secret.slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"), "critical"),
    ("secret.stripe_key", re.compile(r"\b[sr]k_live_[A-Za-z0-9]{20,}\b"), "critical"),
    ("secret.private_key", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"), "critical"),
    ("secret.jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), "high"),
    ("secret.azure_storage", re.compile(r"AccountKey=[A-Za-z0-9+/=]{40,}"), "critical"),
    ("secret.conn_password", re.compile(r"(?i)\b(password|pwd)\s*=\s*[^;'\"\s]{6,}"), "high"),
]
SECRET_CONTEXT = re.compile(r"(?i)(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)")
B64 = re.compile(r"[A-Za-z0-9+/=_-]{20,}")
HEX = re.compile(r"\b[0-9a-fA-F]{32,}\b")


def shannon(s: str) -> float:
    if not s:
        return 0.0
    c = Counter(s)
    n = len(s)
    return -sum(v / n * math.log2(v / n) for v in c.values())


def secrets_in_text(content: str, line_offset: int = 1, context: str = ""):
    out = []
    for rule, rx, sev in SECRET_PATTERNS:
        for m in rx.finditer(content):
            out.append((line_offset + content.count("\n", 0, m.start()), rule, sev, m.group(0)[:12] + "…"))
    if out:
        return out
    ctx = bool(SECRET_CONTEXT.search(context))
    for m in B64.finditer(content):
        tok = m.group(0)
        h = shannon(tok)
        if (h > 4.5) or (ctx and h > 3.5 and len(tok) >= 16):
            if re.fullmatch(r"[A-Za-z]+", tok) or re.fullmatch(r"[a-z_]+", tok.lower()):
                continue   # plain words / identifiers
            out.append((line_offset + content.count("\n", 0, m.start()), "secret.high_entropy_b64",
                        "high" if ctx else "medium", f"H={h:.2f} bits/char"))
    for m in HEX.finditer(content):
        tok = m.group(0)
        h = shannon(tok)
        if h > 3.0 and ctx:
            out.append((line_offset + content.count("\n", 0, m.start()), "secret.high_entropy_hex", "high", f"H={h:.2f}"))
    return out


def secrets(sf):
    out = []
    st = [sf.root]
    while st:
        n = st.pop()
        if n.type in ("string_literal", "verbatim_string_literal", "raw_string_literal"):
            ctx = text(n.parent.parent) if n.parent is not None and n.parent.parent is not None else ""
            out.extend(secrets_in_text(text(n), line0(n), ctx[:200]))
            continue
        if n.type == "comment":
            out.extend(r for r in secrets_in_text(text(n), line0(n)) if r[1] != "secret.high_entropy_b64")
            continue
        st.extend(n.children)
    return out


# (rule, regex over the invocation/creation text, severity, CWE, message)
DANGEROUS = [
    ("sec.insecure_deserializer", re.compile(r"\b(BinaryFormatter|SoapFormatter|NetDataContractSerializer|LosFormatter|ObjectStateFormatter)\b"),
     "high", "CWE-502", "insecure deserializer (CA2300-CA2315)"),
    ("sec.typename_handling", re.compile(r"TypeNameHandling\s*\.\s*(All|Auto|Objects|Arrays)"), "high", "CWE-502",
     "Json.NET TypeNameHandling enables type-confusion deserialization (CA2326)"),
    ("sec.weak_hash", re.compile(r"\b(MD5|SHA1)(CryptoServiceProvider|Managed|Cng)?\s*(\.\s*Create\s*\(|\()"), "medium", "CWE-328",
     "weak hash algorithm (CA5350/CA5351)"),
    ("sec.weak_cipher", re.compile(r"\b(DES|TripleDES|RC2)(CryptoServiceProvider)?\s*(\.\s*Create\s*\(|\()"), "high", "CWE-327",
     "broken/weak cipher (CA5351)"),
    ("sec.ecb_mode", re.compile(r"CipherMode\s*\.\s*ECB"), "high", "CWE-327", "ECB cipher mode"),
    ("sec.cert_validation_disabled", re.compile(r"(ServerCertificateValidationCallback|RemoteCertificateValidationCallback|ServerCertificateCustomValidationCallback)[^;]*=>\s*true"),
     "high", "CWE-295", "TLS certificate validation disabled (CA5359)"),
    ("sec.dtd_processing", re.compile(r"DtdProcessing\s*\.\s*Parse|XmlResolver\s*=\s*new\s+XmlUrlResolver"), "medium", "CWE-611",
     "XML external entity processing enabled (CA3075/CA3077)"),
    ("sec.sql_concat", re.compile(r"\b(SqlCommand|ExecuteSqlRaw|FromSqlRaw|ExecuteSqlCommand|CommandText)\b[^;]*(\+\s*[A-Za-z_]|\$\")"),
     "high", "CWE-89", "SQL built by string concatenation/interpolation (CA2100)"),
    ("sec.process_start", re.compile(r"Process\s*\.\s*Start\s*\([^)\"]*[A-Za-z_]"), "medium", "CWE-78", "process started with non-literal input"),
    ("sec.insecure_random", re.compile(r"new\s+Random\s*\("), "low", "CWE-338", "System.Random is not cryptographically secure (CA5394)"),
]
RELIABILITY = [
    ("rel.sync_over_async", re.compile(r"\.\s*(Result|Wait\s*\(\s*\)|GetAwaiter\s*\(\s*\)\s*\.\s*GetResult\s*\(\s*\))"), "medium",
     "blocking on a Task (sync-over-async deadlock risk, VSTHRD002)"),
    ("rel.lock_this", re.compile(r"\block\s*\(\s*(this\s*\)|typeof\s*\(|\")"), "medium", "lock on publicly accessible object (CA2002)"),
    ("rel.gc_collect", re.compile(r"\bGC\s*\.\s*Collect\s*\("), "low", "explicit GC.Collect"),
]


def dangerous_apis(sf):
    out = []
    st = [sf.root]
    while st:
        n = st.pop()
        if n.type in ("invocation_expression", "object_creation_expression", "assignment_expression",
                      "member_access_expression", "local_declaration_statement"):
            if n.type == "member_access_expression" and n.parent is not None and n.parent.type in (
                    "invocation_expression", "member_access_expression", "assignment_expression"):
                st.extend(n.children)
                continue
            tx = text(n)
            for rule, rx, sev, cwe, msg in DANGEROUS:
                if rx.search(tx):
                    out.append((line0(n), rule, sev, cwe, msg))
            if n.type in ("assignment_expression", "local_declaration_statement"):
                continue
        st.extend(n.children)
    # dedupe same line + rule
    seen, uniq = set(), []
    for o in out:
        if (o[0], o[1]) not in seen:
            seen.add((o[0], o[1])); uniq.append(o)
    return uniq


def reliability(sf, units):
    out = []
    for u in units:
        if u.kind == "method" and "async" in u.mods and u.returns.strip() == "void":
            pl = text(u.node.child_by_field_name("parameters"))
            if "EventArgs" not in pl:
                out.append((u.start, "rel.async_void", "medium", f"async void method '{u.name}' (exceptions crash the process)"))
    st = [sf.root]
    while st:
        n = st.pop()
        if n.type in ("member_access_expression", "lock_statement", "invocation_expression"):
            tx = text(n)
            if n.type == "member_access_expression":
                nm = n.child_by_field_name("name")
                if nm is not None and text(nm) == "Result":
                    exp = text(n.child_by_field_name("expression")).lower()
                    if "task" in exp or "async" in exp:
                        out.append((line0(n), "rel.sync_over_async", "medium", "blocking on Task.Result (VSTHRD002)"))
            elif n.type == "lock_statement":
                m = RELIABILITY[1][1].search(tx[:tx.find("{")] if "{" in tx else tx)
                if m:
                    out.append((line0(n), "rel.lock_this", "medium", RELIABILITY[1][3]))
            elif n.type == "invocation_expression":
                f = n.child_by_field_name("function")
                ft = text(f)
                if re.search(r"(GetAwaiter\(\)\s*\.\s*GetResult|\.Wait)$", ft) and n.child_by_field_name("arguments") is not None \
                        and text(n.child_by_field_name("arguments")) == "()":
                    out.append((line0(n), "rel.sync_over_async", "medium", RELIABILITY[0][3]))
                if re.fullmatch(r"GC\s*\.\s*Collect", ft):
                    out.append((line0(n), "rel.gc_collect", "low", RELIABILITY[2][3]))
        if n.type == "binary_expression":
            op = n.child_by_field_name("operator")
            if op is not None and op.type in ("==", "!="):
                l, r = n.child_by_field_name("left"), n.child_by_field_name("right")
                if (l is not None and l.type == "real_literal") or (r is not None and r.type == "real_literal"):
                    out.append((line0(n), "rel.float_equality", "low", "floating-point equality comparison (S1244)"))
        st.extend(n.children)
    return out


PKG = re.compile(r'<Package(?:Version|Reference)\s+Include="([^"]+)"\s+Version="([^"]+)"', re.I)


def package_inventory(repo: Path):
    """[(package, version, file)] from Directory.Packages.props and *.csproj."""
    out = []
    for p in list(repo.rglob("Directory.Packages.props")) + list(repo.rglob("*.csproj")):
        if any(s in p.parts for s in ("obj", "bin", "node_modules")):
            continue
        for m in PKG.finditer(p.read_text(errors="ignore")):
            ver = m.group(2)
            if "$(" in ver:
                continue
            out.append((m.group(1), ver, str(p.relative_to(repo))))
    return sorted(set(out))
