#!/usr/bin/env python3
"""Read-only Gmail access for the gmail component, over the heartbeat's IMAP helper.

    python3 mail.py new [--validity V --after UID] [--hours 24] [--limit 40]
    python3 mail.py ids <Message-ID>...
    python3 mail.py thread <Message-ID>
    python3 mail.py sender <address>

Credentials and the connection come from jobs/eva-heartbeat/scripts/gmail.py under $EVA_ROOT
(default ~/Eva), which reads secrets/gmail.env; this file never sees them printed or logged.
"[Gmail]/All Mail" is selected with EXAMINE (read-only) and bodies are fetched with BODY.PEEK,
so nothing here can mark read, label, archive, send or delete. Prints one JSON object; on failure
{"error": "<type>: <first line>"} and exit 2.
"""
import email, importlib.util, json, os, re, sys
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime
from html import unescape
from pathlib import Path

EVA_ROOT = Path(os.environ.get("EVA_ROOT") or Path.home() / "Eva")
HEARTBEAT = EVA_ROOT / "jobs" / "eva-heartbeat" / "scripts" / "gmail.py"
ALL_MAIL = '"[Gmail]/All Mail"'
# Mail to Isaac: not what he sent, drafted or chatted. Spam and Trash are not in All Mail.
INBOUND = "-in:sent -in:drafts -in:chats"
BODY_CHARS = 1500
THREAD_MESSAGES = 8
THREAD_CHARS = 1200
ADDRESS = re.compile(r"^[^@\s\"'()<>]+@[^@\s\"'()<>]+$")


def heartbeat():
    spec = importlib.util.spec_from_file_location("eva_heartbeat_gmail", HEARTBEAT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hb = heartbeat()


def connect():
    m = hb.connect(hb.env("secrets/gmail.env"))
    typ, _ = m.select(ALL_MAIL, readonly=True)
    if typ != "OK":
        raise RuntimeError("cannot examine [Gmail]/All Mail")
    return m


def status_number(m, name):
    typ, data = m.response(name)
    return int(data[0]) if data and data[0] else 0


def search(m, *criteria):
    typ, d = m.uid("SEARCH", *criteria)
    return sorted(int(u) for u in d[0].split()) if d and d[0] else []


def raw(query):
    return ("X-GM-RAW", '"' + query.replace('"', '\\"') + '"')


def text_of(msg, limit):
    plain = html = None
    for part in (msg.walk() if msg.is_multipart() else [msg]):
        kind = part.get_content_type()
        if kind == "text/plain" and plain is None:
            plain = part
        elif kind == "text/html" and html is None:
            html = part
    part = plain or html
    if part is None:
        return ""
    try:
        text = (part.get_payload(decode=True) or b"").decode(part.get_content_charset() or "utf-8", "replace")
    except Exception:
        text = str(part.get_payload())
    if part is html:
        text = re.sub(r"(?is)<(script|style).*?</\1>", " ", text)
        text = unescape(re.sub(r"<[^>]+>", " ", text))
    # Quoted history is what read_thread is for.
    text = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(">"))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def label_list(match):
    """X-GM-LABELS as plain names: `\\Inbox`, `\\Starred`, `Eva/Updates`."""
    return [label.strip('"').replace("\\\\", "\\") for label in re.findall(r'"[^"]*"|\S+', match.group(1))] if match else []


def iso(value):
    try:
        when = parsedate_to_datetime(value)
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def fetch(m, uids, body_chars):
    if not uids:
        return []
    typ, data = m.uid("FETCH", ",".join(str(u) for u in uids), f"(UID X-GM-LABELS BODY.PEEK[]<0.{body_chars * 20}>)")
    out = []
    for item in data:
        if not isinstance(item, tuple):
            continue
        head = item[0].decode("utf-8", "replace")
        uid = int(re.search(r"UID (\d+)", head).group(1))
        labels = label_list(re.search(r"X-GM-LABELS \((.*?)\)", head))
        msg = email.message_from_bytes(item[1])
        name, address = parseaddr(hb.dh(msg["From"]))
        out.append({
            "uid": uid,
            "id": (msg["Message-ID"] or "").strip() or f"uid:{uid}",
            "from": (name or address or "unknown")[:80],
            "address": address.lower()[:120],
            "to": re.sub(r"\s+", " ", hb.dh(msg["To"]))[:200],
            "subject": re.sub(r"\s+", " ", hb.dh(msg["Subject"])).strip()[:200] or "(no subject)",
            "date": iso(msg["Date"]),
            "labels": labels,
            "bulk": bool(msg["List-Unsubscribe"]),
            "body": text_of(msg, body_chars),
        })
    return sorted(out, key=lambda message: message["uid"])


def new(args):
    """Inbound mail after the cursor (same UIDVALIDITY), else from the last `hours`; oldest first."""
    validity, after, hours, limit = args.get("validity"), args.get("after"), int(args.get("hours", 24)), int(args.get("limit", 40))
    m = connect()
    try:
        current = status_number(m, "UIDVALIDITY")
        latest = status_number(m, "UIDNEXT") - 1
        if validity is not None and after is not None and int(validity) == current:
            after = int(after)
            # `n:*` answers the highest message even below n, hence the filter.
            uids = [u for u in search(m, "UID", f"{after + 1}:*", *raw(INBOUND)) if u > after]
            floor = after
        else:
            since = datetime.now(timezone.utc) - timedelta(hours=hours)
            uids = search(m, "SINCE", since.strftime("%d-%b-%Y"), *raw(INBOUND))
            floor = 0
        batch = fetch(m, uids[:limit], BODY_CHARS)
        if floor == 0:
            # SINCE is day-granular: keep the window exact.
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
            batch = [message for message in batch if message["date"] >= cutoff]
        through = uids[limit - 1] if len(uids) > limit else max(latest, floor)
        return {"validity": current, "through": through, "messages": batch}
    finally:
        logout(m)


def uid_of(m, message_id):
    found = search(m, *raw("rfc822msgid:" + message_id.strip().strip("<>")))
    return found[-1] if found else None


def ids(message_ids):
    m = connect()
    try:
        uids = [u for u in (uid_of(m, i) for i in message_ids) if u is not None]
        return {"validity": status_number(m, "UIDVALIDITY"), "through": 0, "messages": fetch(m, uids, BODY_CHARS)}
    finally:
        logout(m)


def thread(message_id):
    m = connect()
    try:
        uid = uid_of(m, message_id)
        if uid is None:
            return {"error": f"no message {message_id}"}
        typ, data = m.uid("FETCH", str(uid), "(X-GM-THRID)")
        thrid = re.search(rb"X-GM-THRID (\d+)", data[0] if isinstance(data[0], bytes) else data[0][0]).group(1).decode()
        uids = search(m, "X-GM-THRID", thrid)
        messages = fetch(m, uids[-THREAD_MESSAGES:], THREAD_CHARS)
        return {
            "messages_in_thread": len(uids),
            "shown": [{"from": x["from"], "address": x["address"], "date": x["date"], "subject": x["subject"],
                       "sent_by_isaac": "\\Sent" in x["labels"], "text": x["body"]}
                      for x in messages],
        }
    finally:
        logout(m)


def sender(address):
    address = address.strip().strip("<>").lower()
    if not ADDRESS.match(address):
        return {"error": f"not an email address: {address[:80]}"}
    m = connect()
    try:
        received = search(m, *raw(f"from:{address}"))
        recent = fetch_headers(m, received[-5:])
        return {
            "address": address,
            "messages_from": len(received),
            "from_last_90_days": len(search(m, *raw(f"from:{address} newer_than:90d"))),
            "isaac_wrote_to_them": len(search(m, *raw(f"to:{address} in:sent"))),
            "starred_from": len(search(m, *raw(f"from:{address} is:starred"))),
            "recent": recent,
        }
    finally:
        logout(m)


def fetch_headers(m, uids):
    if not uids:
        return []
    typ, data = m.uid("FETCH", ",".join(str(u) for u in uids), "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE)])")
    out = []
    for item in data:
        if isinstance(item, tuple):
            msg = email.message_from_bytes(item[1])
            out.append({"date": iso(msg["Date"]), "subject": re.sub(r"\s+", " ", hb.dh(msg["Subject"])).strip()[:160]})
    return sorted(out, key=lambda x: x["date"], reverse=True)


def logout(m):
    try:
        m.logout()
    except Exception:
        pass


def flags(argv):
    out = {}
    for i in range(0, len(argv) - 1, 2):
        if argv[i].startswith("--"):
            out[argv[i][2:]] = argv[i + 1]
    return out


def main(argv):
    try:
        command, rest = argv[0], argv[1:]
        if command == "new":
            result = new(flags(rest))
        elif command == "ids":
            result = ids(rest)
        elif command == "thread":
            result = thread(rest[0])
        elif command == "sender":
            result = sender(rest[0])
        else:
            raise ValueError(f"unknown command {command}")
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {str(e).splitlines()[0][:160] if str(e) else ''}"}))
        sys.exit(2)
    print(json.dumps(result))


if __name__ == "__main__":
    main(sys.argv[1:])
