#!/usr/bin/env python3
"""
SCAAI Semantic Memory Bridge v3
- Uses chromadb.utils.embedding_functions.ONNXMiniLM_L6_V2 (fast, no internet needed)
  Falls back to hash-based embeddings if ONNX not available
- Args: python semantic_bridge.py <command>
        python semantic_bridge.py <command> '{"key":"val"}'
        python semantic_bridge.py <command> --file /path/to/args.json
Commands: init, search, store, stats, recall, learn, forget, delete, list_all, ingest
"""
import sys, json, os, hashlib, time, warnings
import sqlite3

# Suppress ALL warnings and chromadb telemetry noise before any imports
warnings.filterwarnings("ignore")
os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")
os.environ.setdefault("CHROMA_TELEMETRY", "False")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTHONWARNINGS", "ignore")

# Silence chromadb startup noise  -  capture both stdout and stderr during import
import io as _io
_real_stdout = sys.stdout
_real_stderr = sys.stderr
sys.stdout = _io.StringIO()
sys.stderr = _io.StringIO()
try:
    import chromadb as _chroma_preload
except Exception:
    pass
finally:
    sys.stdout = _real_stdout
    sys.stderr = _real_stderr

CHROMA_PATH = os.path.expanduser("~/.scaai/chroma_db")
GRAPH_DB_PATH = os.path.expanduser("~/.scaai/knowledge_graph.db")

def init_graph_db():
    conn = sqlite3.connect(GRAPH_DB_PATH)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS entities (
            id TEXT PRIMARY KEY,
            label TEXT,
            type TEXT
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS edges (
            source TEXT,
            target TEXT,
            relation TEXT,
            ts INTEGER,
            PRIMARY KEY (source, target, relation),
            FOREIGN KEY (source) REFERENCES entities (id),
            FOREIGN KEY (target) REFERENCES entities (id)
        )
    ''')
    # ── Schema migrations (additive, safe to re-run) ──
    for col, ctype, default in [
        ('access_count', 'INTEGER', '0'),
        ('last_accessed', 'INTEGER', '0'),
        ('importance', 'REAL', '0.0'),
    ]:
        try:
            c.execute(f'ALTER TABLE entities ADD COLUMN {col} {ctype} DEFAULT {default}')
        except Exception:
            pass  # column already exists
    for col, ctype, default in [
        ('weight', 'REAL', '1.0'),
        ('access_count', 'INTEGER', '0'),
    ]:
        try:
            c.execute(f'ALTER TABLE edges ADD COLUMN {col} {ctype} DEFAULT {default}')
        except Exception:
            pass  # column already exists
    conn.commit()
    return conn

def parse_args():
    argv = sys.argv[1:]
    if not argv:
        return None, {}
    cmd = argv[0]
    args = {}
    if len(argv) >= 3 and argv[1] == '--file':
        try:
            with open(argv[2], 'r', encoding='utf-8') as f:
                args = json.load(f)
        except Exception:
            args = {}
    elif len(argv) >= 2:
        try:
            args = json.loads(argv[1])
        except Exception:
            args = {}
    return cmd, args

def get_embedding_fn():
    """
    Return the fastest available embedding function.
    Priority: ONNX (fast, local) > hash-based fallback (instant, no deps)
    Avoids sentence-transformers which downloads 90MB model on first use.
    """
    try:
        from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2
        return ONNXMiniLM_L6_V2()
    except Exception:
        pass
    # Hash-based fallback  -  deterministic, no downloads, works offline
    # Not as semantically rich but always works instantly
    try:
        from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
        # DefaultEmbeddingFunction may still pull sentence-transformers; test it
        fn = DefaultEmbeddingFunction()
        # Quick test to see if it works without downloading
        fn(["test"])
        return fn
    except Exception:
        pass
    # Final fallback: simple hash embeddings (256-dim)
    # Cosine similarity still works  -  just less semantic
    class HashEmbeddings:
        def __call__(self, texts):
            results = []
            for text in texts:
                vec = [0.0] * 256
                for i, ch in enumerate(text[:2048]):
                    idx = (ord(ch) * 31 + i) % 256
                    vec[idx] += 1.0
                norm = sum(v*v for v in vec) ** 0.5 or 1.0
                results.append([v/norm for v in vec])
            return results
    return HashEmbeddings()

_embedding_fn = None
def get_ef():
    global _embedding_fn
    if _embedding_fn is None:
        _embedding_fn = get_embedding_fn()
    return _embedding_fn

def get_client():
    import chromadb
    # chromadb 1.x removed Settings and the settings= kwarg.
    _so, _se = sys.stdout, sys.stderr
    sys.stdout = _io.StringIO()
    sys.stderr = _io.StringIO()
    try:
        try:
            client = chromadb.PersistentClient(path=CHROMA_PATH)
        except TypeError:
            from chromadb.config import Settings as _S
            client = chromadb.PersistentClient(
                path=CHROMA_PATH,
                settings=_S(anonymized_telemetry=False)
            )
    finally:
        sys.stdout = _so
        sys.stderr = _se
    return client

def get_collection(client):
    # Check if collection already exists to avoid embedding function conflict.
    # ChromaDB persists the embedding function name; passing a different one
    # to get_or_create_collection raises an error on existing collections.
    try:
        existing = [c.name for c in client.list_collections()]
    except Exception:
        existing = []
    if "scaai_memory" in existing:
        # Collection exists  -  retrieve without specifying embedding_function
        # so ChromaDB uses whatever is persisted (avoids conflict error)
        return client.get_collection(name="scaai_memory")
    # First time  -  create with our preferred embedding function
    return client.create_collection(
        name="scaai_memory",
        embedding_function=get_ef(),
        metadata={"hnsw:space": "cosine"}
    )


def out(data):
    # Write to _real_stdout - sys.stdout may be a StringIO at call time.
    _real_stdout.write("SCAAI_JSON:" + json.dumps(data) + chr(10))
    _real_stdout.flush()

def cmd_init():
    try:
        client = get_client()
        col = get_collection(client)
        count = col.count()
        out({"ok": True, "count": count, "path": CHROMA_PATH})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_search(args):
    try:
        query = args.get("query", "")
        n = args.get("n", 5)
        filter_type = args.get("type", None)
        if not query:
            out({"ok": False, "error": "empty query"})
            return
        client = get_client()
        col = get_collection(client)
        if col.count() == 0:
            out({"ok": True, "results": []})
            return
        where = {"type": filter_type} if filter_type else None
        kwargs = {"query_texts": [query], "n_results": min(n, col.count())}
        if where:
            kwargs["where"] = where
        results = col.query(**kwargs)
        res_out = []
        for i, doc in enumerate(results["documents"][0]):
            meta = results["metadatas"][0][i] if results.get("metadatas") else {}
            dist = results["distances"][0][i] if results.get("distances") else 1.0
            res_out.append({
                "content": doc, "meta": meta,
                "score": round(1 - dist, 4),
                "id": results["ids"][0][i] if results.get("ids") else ""
            })
        out({"ok": True, "results": res_out})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_store(args):
    try:
        content = args.get("content", "")
        meta    = args.get("meta", {})
        doc_id  = args.get("id", None)
        if not content:
            out({"ok": False, "error": "empty content"})
            return
        if not doc_id:
            doc_id = "doc_" + hashlib.md5((content[:200] + str(time.time())).encode()).hexdigest()[:12]
        meta["ts"] = meta.get("ts", str(int(time.time())))
        client = get_client()
        col = get_collection(client)
        col.upsert(documents=[content], metadatas=[meta], ids=[doc_id])
        out({"ok": True, "id": doc_id, "count": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_stats():
    try:
        client = get_client()
        col = get_collection(client)
        count = col.count()
        peek = col.peek(limit=5) if count > 0 else {}
        recent = []
        if peek and peek.get("documents"):
            for i, doc in enumerate(peek["documents"]):
                meta = peek["metadatas"][i] if peek.get("metadatas") else {}
                recent.append({"content": doc[:120], "meta": meta})
        out({"ok": True, "count": count, "path": CHROMA_PATH, "recent": recent})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_recall(args):
    args["n"] = args.get("n", 8)
    cmd_search(args)

def cmd_learn(args):
    try:
        content = args.get("content", "")
        label   = args.get("label", "")
        tags    = args.get("tags", [])
        if not content:
            out({"ok": False, "error": "empty content"})
            return
        meta = {
            "type":   "learned",
            "label":  label,
            "tags":   ",".join(tags) if tags else "",
            "ts":     str(int(time.time())),
            "source": args.get("source", "user"),
        }
        if label:
            doc_id = "learn_" + hashlib.md5(label.lower().encode()).hexdigest()[:12]
        else:
            doc_id = "learn_" + hashlib.md5((content[:200] + str(time.time())).encode()).hexdigest()[:12]
        client = get_client()
        col = get_collection(client)
        col.upsert(documents=[content], metadatas=[meta], ids=[doc_id])
        out({"ok": True, "id": doc_id, "label": label, "count": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_forget(args):
    try:
        doc_id  = args.get("id", None)
        label   = args.get("label", None)
        keyword = args.get("keyword", None)
        client  = get_client()
        col     = get_collection(client)
        deleted_ids = []
        if doc_id:
            col.delete(ids=[doc_id])
            deleted_ids.append(doc_id)
        elif label:
            guessed = "learn_" + hashlib.md5(label.lower().encode()).hexdigest()[:12]
            try:
                col.delete(ids=[guessed])
                deleted_ids.append(guessed)
            except Exception:
                pass
            try:
                res = col.get(where={"label": label})
                if res and res.get("ids"):
                    col.delete(ids=res["ids"])
                    deleted_ids.extend(res["ids"])
            except Exception:
                pass
        elif keyword:
            if col.count() > 0:
                res = col.query(query_texts=[keyword], n_results=min(5, col.count()))
                if res and res.get("ids") and res["ids"][0]:
                    col.delete(ids=res["ids"][0])
                    deleted_ids.extend(res["ids"][0])
        out({"ok": True, "deleted": deleted_ids, "remaining": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_list_all(args):
    try:
        limit  = args.get("limit", 20)
        offset = args.get("offset", 0)
        client = get_client()
        col    = get_collection(client)
        count  = col.count()
        if count == 0:
            out({"ok": True, "entries": [], "total": 0})
            return
        res = col.get(limit=min(limit, count), offset=offset,
                      include=["documents", "metadatas"])
        entries = []
        if res and res.get("documents"):
            for i, doc in enumerate(res["documents"]):
                meta = res["metadatas"][i] if res.get("metadatas") else {}
                entries.append({
                    "id":      res["ids"][i] if res.get("ids") else "",
                    "content": doc[:200], "meta": meta,
                })
        out({"ok": True, "entries": entries, "total": count, "offset": offset})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_ingest(args):
    """
    Batch-ingest chunks from one or more files into ChromaDB as type:knowledge.
    args = {
      "chunks": [
        {"content": "...", "source": "filename.md", "chunk_id": 0},
        ...
      ]
    }
    Uses deterministic IDs (kb_<hash of source+chunk_id>) so re-ingesting
    the same file is idempotent  -  existing chunks are upserted, not duplicated.
    """
    try:
        chunks = args.get("chunks", [])
        if not chunks:
            out({"ok": False, "error": "no chunks provided"})
            return
        client = get_client()
        col    = get_collection(client)
        stored = 0
        ids, docs, metas = [], [], []
        for c in chunks:
            content_text = c.get("content", "").strip()
            if not content_text or len(content_text) < 20:
                continue
            source   = c.get("source", "unknown")
            chunk_id = c.get("chunk_id", 0)
            # Deterministic ID  -  same source+chunk_id always maps to same vector slot
            raw_id   = f"kb_{source}_{chunk_id}"
            doc_id   = "kb_" + hashlib.md5(raw_id.encode()).hexdigest()[:16]
            meta = {
                "type":     "knowledge",
                "source":   source,
                "chunk_id": str(chunk_id),
                "ts":       str(int(time.time())),
                "label":    f"{source}_{chunk_id}",
            }
            ids.append(doc_id)
            docs.append(content_text)
            metas.append(meta)
            stored += 1
        if not ids:
            out({"ok": False, "error": "all chunks were empty or too short"})
            return
        # Upsert in one batch  -  efficient for large files
        col.upsert(documents=docs, metadatas=metas, ids=ids)
        out({"ok": True, "stored": stored, "count": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_context(args):
    """
    Tiered multi-query context fetch for the cognitive pipeline.
    TIER 1: Always fetch ALL learned/identity/preference/project facts first.
    TIER 2: Fill remaining slots with semantic search across exchange+synthesis.
    This prevents high-value profile facts from being crowded out by exchange volume.
    """
    import time
    try:
        queries   = args.get("queries", [])
        n         = args.get("n", 5)
        min_score = args.get("min_score", 0.08)
        if not queries:
            out({"ok": False, "error": "no queries provided"})
            return
        client = get_client()
        col    = get_collection(client)
        total  = col.count()
        if total == 0:
            out({"ok": True, "results": [], "total_db": 0})
            return

        seen_ids = set()
        merged   = []

        # TIER 1: Always include ALL structured facts (never crowded out by exchange volume)
        for type_filter in ["learned", "identity", "preference", "project"]:
            try:
                res = col.get(
                    where={"type": type_filter},
                    limit=50,
                    include=["documents", "metadatas", "ids"]
                )
                if not res or not res.get("documents"):
                    continue
                for i, doc in enumerate(res["documents"]):
                    rid  = res["ids"][i] if res.get("ids") else ""
                    meta = res["metadatas"][i] if res.get("metadatas") else {}
                    if rid in seen_ids:
                        continue
                    seen_ids.add(rid)
                    merged.append({
                        "content": doc, "meta": meta, "score": 1.0,
                        "id": rid, "matched_query": "__profile__", "tier": 1
                    })
            except Exception:
                continue

        # TIER 2: Semantic search for exchange + synthesis entries
        for q in queries[:10]:
            if not q or not q.strip():
                continue
            try:
                res = col.query(
                    query_texts=[q],
                    n_results=min(n, total),
                    include=["documents", "metadatas", "distances", "ids"]
                )
                for i, doc in enumerate(res["documents"][0]):
                    rid   = res["ids"][0][i] if res.get("ids") else ""
                    dist  = res["distances"][0][i] if res.get("distances") else 1.0
                    score = round(1 - dist, 4)
                    meta  = res["metadatas"][0][i] if res.get("metadatas") else {}
                    mtype = meta.get("type", "")
                    if mtype in ("learned", "identity", "preference", "project"):
                        continue  # already in tier 1
                    if score < min_score:
                        continue
                    if rid in seen_ids:
                        for m in merged:
                            if m["id"] == rid and score > m["score"]:
                                m["score"] = score
                        continue
                    seen_ids.add(rid)
                    merged.append({
                        "content": doc, "meta": meta, "score": score,
                        "id": rid, "matched_query": q[:60], "tier": 2
                    })
            except Exception:
                continue

        merged.sort(key=lambda x: (x.get("tier", 2), -x["score"]))
        out({"ok": True, "results": merged[:n*3], "total_db": total})
    except Exception as e:
        out({"ok": False, "error": str(e)})
def cmd_profile(args):
    try:
        client = get_client()
        col    = get_collection(client)
        if col.count() == 0:
            out({"ok": True, "facts": [], "total": 0})
            return
        facts = []
        for type_filter in ["learned", "identity", "preference", "project"]:
            try:
                res = col.get(where={"type": type_filter}, limit=50,
                              include=["documents","metadatas"])
                if res and res.get("documents"):
                    for i, doc in enumerate(res["documents"]):
                        meta = res["metadatas"][i] if res.get("metadatas") else {}
                        facts.append({"content":doc,"type":type_filter,
                                      "label":meta.get("label",""),"ts":meta.get("ts",""),
                                      "id":res["ids"][i] if res.get("ids") else ""})
            except Exception:
                continue
        seen = set()
        unique = []
        for f in facts:
            if f["id"] not in seen:
                seen.add(f["id"])
                unique.append(f)
        unique.sort(key=lambda x: x.get("ts",""), reverse=True)
        out({"ok": True, "facts": unique, "total": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_recall_by_date(args):
    try:
        ts_from = int(args.get("ts_from", 0))
        ts_to   = int(args.get("ts_to", 9999999999))
        n       = int(args.get("n", 20))
        client  = get_client()
        col     = get_collection(client)
        if col.count() == 0:
            out({"ok": True, "results": [], "window": {"from": ts_from, "to": ts_to}})
            return
        res = col.get(limit=min(col.count(), 2000), include=["documents","metadatas"])
        entries = []
        if res and res.get("documents"):
            for i, doc in enumerate(res["documents"]):
                meta = res["metadatas"][i] if res.get("metadatas") else {}
                try:
                    ts_val = int(meta.get("ts","0"))
                except (ValueError, TypeError):
                    continue
                if ts_from <= ts_val <= ts_to:
                    entries.append({"content":doc,"meta":meta,"ts":ts_val,
                                    "id":res["ids"][i] if res.get("ids") else ""})
        entries.sort(key=lambda x: x["ts"])
        entries = entries[:n]
        out({"ok": True, "results": entries, "total_in_window": len(entries),
             "window": {"from": ts_from, "to": ts_to}})
    except Exception as e:
        out({"ok": False, "error": str(e)})
def cmd_analyze(args):
    import re as _re
    import zipfile as _zf
    try:
        root       = args.get("path","").strip()
        max_depth  = int(args.get("max_depth",4))
        max_files  = int(args.get("max_files",300))
        ext_filter = args.get("extensions",None)
        label      = args.get("label","").strip()
        if not root:
            out({"ok":False,"error":"path is required"}); return
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            out({"ok":False,"error":"not a directory: "+root}); return

        CODE_EXTS={".py",".js",".jsx",".ts",".tsx",".mjs",".cjs",
                   ".java",".kt",".scala",".go",".rs",".c",".cpp",
                   ".cs",".rb",".php",".swift",".dart",".lua",
                   ".sh",".bash",".zsh",".ps1",".bat",".cmd",
                   ".html",".css",".scss",".less",
                   ".json",".yaml",".yml",".toml",".ini",".xml",".sql"}
        DOC_EXTS={".pdf",".docx",".doc",".odt",".rtf",
                  ".xlsx",".xls",".ods",".csv",
                  ".pptx",".ppt",".odp",
                  ".txt",".md",".rst",
                  ".epub",".pages",".numbers",".key"}
        ALL_EXTS = CODE_EXTS | DOC_EXTS
        allowed = set(("."+e.lstrip(".")) for e in ext_filter) if ext_filter else ALL_EXTS
        SKIP_DIRS={"node_modules",".git",".svn","__pycache__",".mypy_cache",
                   "venv",".venv","env","dist","build",".next",".nuxt",
                   "coverage",".pytest_cache","target","vendor",
                   "Pods",".idea",".vscode","out","bin","obj"}
        NL = chr(10)
        W  = "[A-Za-z0-9_]"
        WS = "[ 	]"
        ID = "[A-Za-z_][A-Za-z0-9_]*"
        LP = "[(]"
        def cp(pat): return _re.compile(pat)
        P_FUNC_PY    = cp("^(?:async )?" + "def (" + ID + ")" + WS + "*" + LP)
        P_CLASS_PY   = cp("^class (" + ID + ")" + WS + "*[:(]")
        P_IMPORT_PY  = cp("^(?:import|from) ([A-Za-z0-9_.]+)")
        P_FUNC_JS    = cp("function (" + ID + ")" + WS + "*" + LP + "|const (" + ID + ")" + WS + "*=" + WS + "*(?:async" + WS + "+)?(?:function|" + LP + ")")
        P_CLASS_JS   = cp("class (" + ID + ")")
        P_IMPORT_JS  = cp("(?:import|require)[^A-Za-z0-9_@/.-]+([A-Za-z0-9_./@-]{2,40})")
        P_FUNC_TS    = P_FUNC_JS
        P_CLASS_TS   = P_CLASS_JS
        P_IMPORT_TS  = cp("from [^A-Za-z0-9_@/.-]+([A-Za-z0-9_./@-]{2,40})")
        P_FUNC_GO    = cp("^func .*?(" + ID + ")" + WS + "*" + LP)
        P_CLASS_GO   = cp("^type (" + ID + ") (?:struct|interface)")
        P_FUNC_JAVA  = cp("(?:public|private|protected|static)(?:[^;{]+? )(" + ID + ")" + WS + "*" + LP)
        P_CLASS_JAVA = cp("(?:class|interface|enum) (" + ID + ")")
        P_IMPORT_JAVA= cp("^import ([A-Za-z0-9_.]+)")
        EXT_PATS = {
            ".py":   (P_FUNC_PY,   P_CLASS_PY,   P_IMPORT_PY),
            ".js":   (P_FUNC_JS,   P_CLASS_JS,   P_IMPORT_JS),
            ".jsx":  (P_FUNC_JS,   P_CLASS_JS,   P_IMPORT_JS),
            ".mjs":  (P_FUNC_JS,   P_CLASS_JS,   P_IMPORT_JS),
            ".cjs":  (P_FUNC_JS,   P_CLASS_JS,   P_IMPORT_JS),
            ".ts":   (P_FUNC_TS,   P_CLASS_TS,   P_IMPORT_TS),
            ".tsx":  (P_FUNC_TS,   P_CLASS_TS,   P_IMPORT_TS),
            ".go":   (P_FUNC_GO,   P_CLASS_GO,   None),
            ".java": (P_FUNC_JAVA, P_CLASS_JAVA, P_IMPORT_JAVA),
            ".kt":   (P_FUNC_JAVA, P_CLASS_JAVA, P_IMPORT_JAVA),
        }

        def get_sigs(fp, ext):
            pats = EXT_PATS.get(ext)
            if not pats:
                return {"funcs":[],"classes":[],"imports":[],"lines":0}
            fp_pat, cp_pat, ip_pat = pats
            funcs, classes, imports, lc = [], [], [], 0
            try:
                with open(fp, "r", encoding="utf-8", errors="ignore") as fh:
                    flines = fh.readlines()
                lc = len(flines)
                for line in flines[:400]:
                    s = line.strip()
                    if fp_pat:
                        m = fp_pat.search(s)
                        if m:
                            nm = next((g for g in m.groups() if g), None)
                            if nm: funcs.append(nm)
                    if cp_pat:
                        m = cp_pat.search(s)
                        if m:
                            nm = next((g for g in m.groups() if g), None)
                            if nm: classes.append(nm)
                    if ip_pat:
                        m = ip_pat.search(s)
                        if m:
                            nm = next((g for g in m.groups() if g), None)
                            if nm: imports.append(nm)
            except Exception:
                pass
            return {
                "funcs":   list(dict.fromkeys(funcs))[:20],
                "classes": list(dict.fromkeys(classes))[:10],
                "imports": list(dict.fromkeys(imports))[:15],
                "lines":   lc,
            }

        def extract_pdf_text(fp):
            try:
                import struct, zlib
                with open(fp,"rb") as f: raw=f.read()
                # Extract all stream content between stream/endstream markers
                texts=[]
                i=0
                while True:
                    s=raw.find(b"stream",i)
                    if s==-1: break
                    e=raw.find(b"endstream",s)
                    if e==-1: break
                    chunk=raw[s+6:e].strip()
                    try:
                        dec=zlib.decompress(chunk)
                        t=dec.decode("latin-1","ignore")
                        # Extract text between Tj/TJ operators
                        for m in _re.finditer(r'[(\[]([^)(\[\]]{3,200})[)\]][ 	]*(Tj|TJ|")', t):
                            word=m.group(1).strip()
                            if word and len(word)>2: texts.append(word)
                    except Exception:
                        pass
                    i=e+9
                preview=" ".join(texts)
                # Remove PDF control chars
                preview=_re.sub(r'\[0-9]{3}|\[nrtbf]','',preview)
                preview=''.join(c for c in preview if 32<=ord(c)<=126 or ord(c)==10)
                preview=' '.join(preview.split()).strip()
                return preview[:500] if preview else ""
            except Exception:
                return ""

        def extract_docx_text(fp):
            try:
                with _zf.ZipFile(fp,"r") as z:
                    if "word/document.xml" not in z.namelist(): return ""
                    with z.open("word/document.xml") as xf:
                        xml=xf.read().decode("utf-8","ignore")
                text=_re.sub(r'<[^>]+>','',xml)
                text=_re.sub(r'\s+',' ',text).strip()
                return text[:500]
            except Exception: return ""

        def extract_xlsx_meta(fp):
            try:
                with _zf.ZipFile(fp,"r") as z:
                    names=z.namelist()
                    sheets=[n.split("/")[-1].replace(".xml","")
                            for n in names if n.startswith("xl/worksheets/sheet")]
                    shared_text=""
                    if "xl/sharedStrings.xml" in names:
                        with z.open("xl/sharedStrings.xml") as sf:
                            xml=sf.read().decode("utf-8","ignore")
                        vals=_re.findall(r'<t[^>]*>([^<]{1,80})</t>',xml)
                        shared_text=", ".join(vals[:20])
                    return "sheets: "+str(len(sheets))+("; headers: "+shared_text[:200] if shared_text else "")
            except Exception: return ""

        def extract_pptx_meta(fp):
            try:
                with _zf.ZipFile(fp,"r") as z:
                    slide_count=len([n for n in z.namelist() if _re.match(r'ppt/slides/slide[0-9]+\.xml',n)])
                    texts=[]
                    for nm in sorted(z.namelist()):
                        if _re.match(r'ppt/slides/slide[0-9]+\.xml',nm) and len(texts)<5:
                            with z.open(nm) as sf:
                                xml=sf.read().decode("utf-8","ignore")
                            t=_re.sub(r'<[^>]+>','',xml)
                            t=_re.sub(r'\s+',' ',t).strip()
                            if t: texts.append(t[:100])
                    return str(slide_count)+" slides"+("; "+"; ".join(texts) if texts else "")
            except Exception: return ""

        def extract_csv_meta(fp):
            try:
                with open(fp,"r",encoding="utf-8",errors="ignore") as f:
                    lines=[f.readline() for _ in range(3)]
                headers=lines[0].strip() if lines else ""
                return "headers: "+headers[:200]
            except Exception: return ""

        def extract_txt_preview(fp):
            try:
                with open(fp,"r",encoding="utf-8",errors="ignore") as f:
                    return f.read(400).replace(NL," ").strip()
            except Exception: return ""

        def get_doc_info(fp, ext):
            if ext==".pdf":
                preview=extract_pdf_text(fp)
                return {"type":"pdf","preview":preview}
            elif ext in (".docx",".odt"):
                preview=extract_docx_text(fp)
                return {"type":"document","preview":preview}
            elif ext in (".xlsx",".ods"):
                meta=extract_xlsx_meta(fp)
                return {"type":"spreadsheet","preview":meta}
            elif ext==".pptx":
                meta=extract_pptx_meta(fp)
                return {"type":"presentation","preview":meta}
            elif ext==".csv":
                meta=extract_csv_meta(fp)
                return {"type":"spreadsheet","preview":meta}
            elif ext in (".txt",".md",".rst"):
                preview=extract_txt_preview(fp)
                return {"type":"text","preview":preview}
            else:
                return {"type":"document","preview":""}

        def safe_rel(fp, base):
            try:
                return os.path.relpath(fp, base).replace(chr(92), "/")
            except ValueError:
                return fp.replace(base, "").lstrip("/"+chr(92)).replace(chr(92), "/")

        tree_lines, entries, fc, stats = [], [], 0, {}
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            try:
                rel_dir = os.path.relpath(dirpath, root)
                depth = 0 if rel_dir == "." else rel_dir.replace(chr(92), "/").count("/") + 1
            except ValueError:
                depth = 0
            if depth > max_depth:
                dirnames[:] = []; continue
            indent = "  " * depth
            dname = os.path.basename(root) if depth == 0 else os.path.basename(dirpath)
            tree_lines.append(indent + dname + "/")
            for fname in sorted(filenames):
                if fc >= max_files: break
                ext = os.path.splitext(fname)[1].lower()
                if ext not in allowed: continue
                fp = os.path.join(dirpath, fname)
                try: sz = os.path.getsize(fp)
                except: sz = 0
                is_doc = ext in DOC_EXTS
                if is_doc:
                    info = get_doc_info(fp, ext)
                    tree_lines.append(indent + "  " + fname + "  [" + info["type"] + "," + str(sz//1024) + "KB]")
                    entries.append({"rel": safe_rel(fp, root), "ext": ext, "is_doc": True, "info": info})
                else:
                    s = get_sigs(fp, ext)
                    tree_lines.append(indent + "  " + fname + "  [" + str(s["lines"]) + "L," + str(sz//1024) + "KB]")
                    entries.append({"rel": safe_rel(fp, root), "ext": ext, "is_doc": False, "sigs": s})
                stats[ext] = stats.get(ext, 0) + 1
                fc += 1

        if not entries:
            out({"ok":False,"error":"no matching files found in: "+root}); return
        clabel = label or os.path.basename(os.path.normpath(root)) or "folder"
        ts_now = str(int(time.time()))
        ext_sum = ", ".join(str(v)+"x"+k for k,v in sorted(stats.items(), key=lambda x: -x[1]))
        out_lines = [
            "FOLDER INDEX: "+clabel,
            "Root: "+root,
            "Files: "+str(fc)+" | Types: "+ext_sum,
            "",
            "FILE TREE:",
            NL.join(tree_lines[:200]),
            "",
            "FILE CONTENTS SUMMARY:",
        ]
        for e in entries:
            if e["is_doc"]:
                info=e["info"]
                line="  "+e["rel"]+": ["+info["type"]+"]"
                if info["preview"]: line+=" "+info["preview"][:250]
                out_lines.append(line)
            else:
                s=e["sigs"]; parts=[]
                if s["classes"]: parts.append("classes: "+", ".join(s["classes"]))
                if s["funcs"]:   parts.append("funcs: "+", ".join(s["funcs"][:10]))
                if s["imports"]: parts.append("imports: "+", ".join(s["imports"][:8]))
                if parts: out_lines.append("  "+e["rel"]+": "+" | ".join(parts))
        full = NL.join(out_lines)
        chunks = []
        try:
            client = get_client(); col = get_collection(client)
            try:
                old = col.get(where={"type":"codebase","label":clabel})
                if old and old.get("ids"): col.delete(ids=old["ids"])
            except Exception: pass
            CSIZ, OVL = 1800, 200; rawt = full; st = 0
            while st < len(rawt):
                chunks.append(rawt[st:st+CSIZ]); st += CSIZ - OVL
            if not chunks: chunks = [rawt]
            ids, docs, metas = [], [], []
            for i, ch in enumerate(chunks):
                did = "cb_" + hashlib.md5(("codebase_"+clabel+"_"+str(i)).encode()).hexdigest()[:16]
                ids.append(did); docs.append(ch)
                metas.append({"type":"codebase","label":clabel,"root":root,
                              "chunk_id":str(i),"file_count":str(fc),"ts":ts_now})
            col.upsert(documents=docs, metadatas=metas, ids=ids)
            out({"ok":True,"label":clabel,"file_count":fc,"chunk_count":len(chunks),
                 "db_count":col.count(),"summary":full[:3000],"ext_stats":stats})
        except Exception as db_err:
            out({"ok":False,"error":str(db_err),"summary":full[:3000],
                 "file_count":fc,"label":clabel,"chunk_count":len(chunks)})
    except Exception as top_err:
        out({"ok":False,"error":"analyze failed: "+str(top_err),"file_count":0,"label":"","summary":""})

# ── Deep Codebase Analysis ───────────────────────────────────────────
def cmd_deep_analyze(args):
    import re as _re2, time as _t2, hashlib as _h2
    root      = args.get("path","").strip()
    label     = args.get("label","").strip()
    max_lines = int(args.get("max_lines_per_file",500))
    max_files = int(args.get("max_files",200))
    if not root:   out({"ok":False,"error":"path is required"}); return
    if not label:  out({"ok":False,"error":"label is required"}); return
    if not os.path.isdir(root):
        out({"ok":False,"error":"not a directory: "+root}); return
    CODE_EXTS={".py",".js",".jsx",".ts",".tsx",".mjs",".cjs",
               ".java",".kt",".go",".rs",".c",".cpp",".cs",
               ".rb",".php",".swift",".dart",
               ".html",".css",".scss",".json",".yaml",".yml",".toml",".sql"}
    SKIP_DIRS={"node_modules",".git",".svn","__pycache__",".mypy_cache",
               "venv",".venv","env","dist","build",".next",".nuxt",
               "coverage",".pytest_cache","target","vendor","Pods",
               ".idea",".vscode","out","bin","obj"}
    # ── Pattern building with char classes — no backslash escapes ──
    ID   = "[A-Za-z_][A-Za-z0-9_]*"
    WS   = "[ 	]"
    LP   = "[(]"

    def _cp(pat): return _re2.compile(pat)

    # Import detection using simple string ops (avoids backslash sequences)
    def _imports(lines, ext):
        imps = []
        for line in lines[:50]:
            s = line.strip()
            if ext in (".js",".jsx",".ts",".tsx",".mjs",".cjs"):
                if "from '" in s or "from " + chr(34) in s:
                    for q in ("'", chr(34)):
                        idx = s.find("from " + q)
                        if idx >= 0:
                            start = idx + 6
                            end = s.find(q, start)
                            if end > start: imps.append(s[start:end]); break
                elif "require(" in s:
                    for q in ("'", chr(34)):
                        idx = s.find("require(" + q)
                        if idx >= 0:
                            start = idx + 9
                            end = s.find(q, start)
                            if end > start: imps.append(s[start:end]); break
            elif ext == ".py":
                if s.startswith("from "):
                    parts = s.split()
                    if len(parts) >= 4 and parts[2] == "import": imps.append(parts[1])
                elif s.startswith("import "):
                    parts = s.split()
                    if len(parts) >= 2: imps.append(parts[1].split(".")[0])
            elif ext in (".java",".kt"):
                if s.startswith("import "):
                    imps.append(s[7:].rstrip(";").split()[0] if " " not in s[7:].rstrip(";") else s[7:].rstrip(";"))
        return imps

    # Function extraction with char-class regex
    def _functions(lines, ext):
        funcs = []
        if ext in (".js",".jsx",".ts",".tsx",".mjs",".cjs"):
            func_re = _cp("function " + WS + "*(" + ID + ")" + WS + "*" + LP +
                          "|(?:const|let|var)" + WS + "+(" + ID + ")" + WS + "*=" + WS + "*(?:async" + WS + "+)?(?:function|" + LP + ")")
        elif ext == ".py":
            func_re = _cp("^(?:async )?" + "def (" + ID + ")" + WS + "*" + LP)
        elif ext in (".java",".kt"):
            func_re = _cp("(?:public|private|protected|static|override|fun|void|int|String|boolean|List|Map|" + ID + ") (" + ID + ")" + WS + "*" + LP)
        elif ext == ".go":
            func_re = _cp("^func " + WS + "*(?:" + LP + "[^)]*" + LP + "[^)]*[)] " + WS + "*)?" + "(" + ID + ")" + WS + "*" + LP)
        else:
            return funcs
        SKIP_CALLS = {"console","log","error","warn","print","len","str","int","float",
                      "if","for","while","return","const","let","var","import","require",
                      "super","this","self","new","typeof","instanceof"}
        call_re = _cp("([a-z_][A-Za-z0-9_]{2,30})" + WS + "*" + LP)
        ret_re  = _cp("return ([^;{" + chr(10) + "]{1,60})")
        i = 0
        while i < len(lines):
            m = func_re.search(lines[i].strip())
            if m:
                groups = [g for g in m.groups() if g and _re2.match("[A-Za-z_]", g)]
                if not groups: i += 1; continue
                name = groups[0]
                body = lines[i+1:i+22]; purpose = ""; calls = []; returns = "unknown"
                for bl in body:
                    bs = bl.strip()
                    if not purpose:
                        if bs.startswith("//") or bs.startswith("#"):
                            purpose = bs.lstrip("/#").strip()[:100]
                        elif bs.startswith('"""') or bs.startswith("'''"):
                            purpose = bs.strip(" '" + chr(34)).strip()[:100]
                    for c in call_re.findall(bs):
                        if c not in SKIP_CALLS and c != name: calls.append(c)
                    if "return " in bs:
                        rm = ret_re.search(bs)
                        if rm and len(rm.group(1).strip()) < 50: returns = rm.group(1).strip()
                funcs.append({"name":name,"params":[],"returns":returns,
                              "purpose":purpose,"calls":list(dict.fromkeys(calls))[:8],"line":i+1})
                i += 1
            else:
                i += 1
        return funcs[:25]

    # Type/interface detection
    def _types(lines, ext):
        types = []
        if ext in (".ts",".tsx"):
            type_re = _cp("^(?:export )?" + "(?:interface|type|enum|class) (" + ID + ")")
        elif ext == ".py":
            type_re = _cp("^class (" + ID + ")")
        elif ext in (".java",".kt"):
            type_re = _cp("(?:class|interface|enum) (" + ID + ")")
        else:
            return types
        field_re = _cp("^(" + ID + ")[ 	]*[?:]")
        i = 0
        while i < len(lines):
            m = type_re.search(lines[i].strip())
            if m:
                tname = m.group(1); fields = []
                for bl in lines[i+1:i+16]:
                    bs = bl.strip()
                    if bs in ("{","}",""): continue
                    if any(kw in bs for kw in ("function","def ","constructor","return","}")): break
                    fm = field_re.match(bs)
                    if fm and len(fm.group(1)) < 40: fields.append(fm.group(1))
                if fields: types.append({"name":tname,"fields":fields[:10]})
            i += 1
        return types[:15]

    # State pattern detection — simple substring search
    def _state(lines):
        STATE_HOOKS = ("useState","useReducer","useContext","useStore","useSelector",
                       "useDispatch","createSlice","createStore","observable","action",
                       "computed","this.state","this.setState","sessionStorage","localStorage","indexedDB")
        found = set(); result = []
        joined = " ".join(l.strip() for l in lines)
        for hook in STATE_HOOKS:
            if hook in joined and hook not in found:
                found.add(hook); result.append(hook)
        return result[:8]

    # Module purpose heuristic
    def _purpose(lines, fname, ext, classes, funcs, exports):
        header = []
        for line in lines[:12]:
            s = line.strip()
            if s.startswith("//") or s.startswith("#") or s.startswith("*") or s.startswith('"""'):
                c = s.lstrip("/#* " + chr(34)).strip()
                if len(c) > 10: header.append(c)
        fn = fname.lower(); role = ""
        for pat, lbl in [("route|router","routing"),("store|redux|slice","state management"),
                         ("service|api|client|fetch","API/service"),("util|helper|common","utilities"),
                         ("model|schema|type|interface","data model"),("hook","React hook"),
                         ("context|provider","context/provider"),("test|spec","tests"),
                         ("config|setting","configuration")]:
            if _re2.search(pat, fn): role = lbl; break
        if not role:
            if ext in (".css",".scss",".sass",".less"): role = "styles"
            elif ext in (".json",".yaml",".yml",".toml"): role = "config data"
            elif exports: role = "component/module"
        p = header[0] if header else ""
        if role and p: return role + " — " + p
        if role: return role
        if p: return p
        if classes: return "defines " + (", ".join(classes[:2]))
        if funcs: return "exports " + (", ".join(f["name"] for f in funcs[:3]))
        return "module"

    # ── Walk and analyze ──
    dep_graph = {}; deep_entries = []; file_count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fname in sorted(filenames):
            if file_count >= max_files: break
            ext = os.path.splitext(fname)[1].lower()
            if ext not in CODE_EXTS: continue
            filepath = os.path.join(dirpath, fname)
            rel = os.path.relpath(filepath, root)
            try:
                with open(filepath,"r",encoding="utf-8",errors="ignore") as f:
                    all_lines = f.readlines()
                lines = all_lines[:max_lines]
            except: continue
            imps    = _imports(lines, ext)
            funcs_  = _functions(lines, ext)
            types_  = _types(lines, ext)
            state_  = _state(lines)
            exports_ = []
            for line in lines:
                for m in _re2.finditer("export (?:default )?(?:function|class|const|let|var|interface|type|enum) (" + ID + ")", line):
                    exports_.append(m.group(1))
            exports_ = list(dict.fromkeys(exports_))[:10]
            joined_str = "".join(l.strip() for l in lines)
            err_ = []
            if "try {" in joined_str or "try{" in joined_str or "except " in joined_str: err_.append("try/catch")
            if ".catch(" in joined_str: err_.append("promise.catch")
            if "throw new " in joined_str: err_.append("throws errors")
            dep_graph[rel] = imps
            purpose_ = _purpose(lines, fname, ext, [t["name"] for t in types_], funcs_, exports_)
            deep_entries.append({"rel":rel,"ext":ext,"line_count":len(all_lines),"purpose":purpose_,
                                  "exports":exports_,"imports":imps,"functions":funcs_,
                                  "types":types_,"state":state_,"errors":err_})
            file_count += 1

    if not deep_entries:
        out({"ok":False,"error":"no files found for deep analysis"}); return

    NL = chr(10)
    dep_lines = ["DEPENDENCY GRAPH (who imports who):"]
    for rel, deps in sorted(dep_graph.items()):
        if deps:
            resolved = [d.lstrip("./").replace("/", os.sep) or d if d.startswith(".") else d for d in deps[:6]]
            dep_lines.append("  " + rel + " <- " + (", ".join(resolved[:6])))
    dep_summary = NL.join(dep_lines[:120])

    ts_now = str(int(_t2.time()))
    try:
        client = get_client(); col = get_collection(client)
        try:
            old = col.get(where={"type":"codebase_deep","label":label})
            if old and old.get("ids"): col.delete(ids=old["ids"])
        except: pass
        ids_ = []; docs_ = []; metas_ = []
        for entry in deep_entries:
            chunk_lines = ["FILE: "+entry["rel"]+"  ("+str(entry["line_count"])+" lines)",
                           "PURPOSE: "+entry["purpose"]]
            if entry["exports"]: chunk_lines.append("EXPORTS: "+(", ".join(entry["exports"])))
            for t in entry["types"]:
                chunk_lines.append("TYPE "+t["name"]+": fields=["+(", ".join(t["fields"]))+"]")
            if entry["state"]: chunk_lines.append("STATE: "+(", ".join(entry["state"])))
            if entry["errors"]: chunk_lines.append("ERROR_HANDLING: "+(", ".join(entry["errors"])))
            for fn in entry["functions"]:
                fl = "FN "+fn["name"]+" -> "+fn["returns"]
                if fn["purpose"]: fl += " // "+fn["purpose"]
                if fn["calls"]: fl += " | calls: "+(", ".join(fn["calls"]))
                chunk_lines.append(fl)
            chunk_text = NL.join(chunk_lines)
            doc_id = "dp_" + _h2.md5(("deep_"+label+"_"+entry["rel"]).encode()).hexdigest()[:16]
            ids_.append(doc_id); docs_.append(chunk_text)
            metas_.append({"type":"codebase_deep","label":label,"file":entry["rel"],"root":root,"ts":ts_now})
        dep_id = "dp_" + _h2.md5(("depgraph_"+label).encode()).hexdigest()[:16]
        ids_.append(dep_id); docs_.append(dep_summary)
        metas_.append({"type":"codebase_deep","label":label,"file":"__dep_graph__","root":root,"ts":ts_now})
        col.upsert(documents=docs_, metadatas=metas_, ids=ids_)
        out({"ok":True,"label":label,"files_analyzed":file_count,
             "chunks_stored":len(ids_),"db_count":col.count()})
    except Exception as e:
        out({"ok":False,"error":str(e)})

def cmd_embedding_check():
    """
    Detect which embedding function is actually active.
    Returns: {ok, engine, dim, semantic} where semantic=True means real embeddings.
    Used by the UI to warn the user if they are running hash-based fallback.
    """
    try:
        # Test ONNX first
        try:
            from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2
            ef = ONNXMiniLM_L6_V2()
            test = ef(["test semantic embedding quality"])
            dim = len(test[0]) if test else 0
            out({"ok": True, "engine": "ONNXMiniLM_L6_V2", "dim": dim, "semantic": True,
                 "note": "Real semantic embeddings active. Retrieval quality: excellent."})
            return
        except Exception:
            pass
        # Test sentence-transformers default
        try:
            from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
            ef = DefaultEmbeddingFunction()
            test = ef(["test"])
            dim = len(test[0]) if test else 0
            out({"ok": True, "engine": "DefaultEmbeddingFunction", "dim": dim, "semantic": True,
                 "note": "sentence-transformers embeddings active. Retrieval quality: good."})
            return
        except Exception:
            pass
        # Hash fallback is active — this is the problem
        out({"ok": True, "engine": "HashEmbeddings_fallback", "dim": 256, "semantic": False,
             "note": "WARNING: Hash-based embeddings active. Retrieval quality: poor. "
                     "Install ONNX embeddings: pip install 'chromadb[onnx]' or pip install onnxruntime"})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_health(args):
    """
    Returns memory health stats: entry count by type, timestamp distribution,
    most common topic tags. Used by the memory health dashboard (U12).
    """
    try:
        client = get_client()
        col    = get_collection(client)
        total  = col.count()
        if total == 0:
            out({"ok": True, "total": 0, "by_type": {}, "by_source": {}, "topics": [], "oldest_ts": None, "newest_ts": None})
            return

        type_counts   = {}
        source_counts = {}
        topic_freq    = {}
        oldest_ts     = None
        newest_ts     = None
        batch_size    = 200
        offset        = 0

        while offset < total:
            res = col.get(limit=batch_size, offset=offset, include=["metadatas"])
            if not res or not res.get("metadatas"):
                break
            for meta in res["metadatas"]:
                mtype  = meta.get("type", "unknown")
                msrc   = meta.get("source", "")
                mtopic = meta.get("topic", "")
                mts    = meta.get("ts", "")
                type_counts[mtype]   = type_counts.get(mtype, 0) + 1
                if msrc:
                    source_counts[msrc] = source_counts.get(msrc, 0) + 1
                if mtopic:
                    for tag in mtopic.split(","):
                        t = tag.strip()
                        if t and len(t) > 3:
                            topic_freq[t] = topic_freq.get(t, 0) + 1
                try:
                    ts_int = int(mts)
                    if oldest_ts is None or ts_int < oldest_ts:
                        oldest_ts = ts_int
                    if newest_ts is None or ts_int > newest_ts:
                        newest_ts = ts_int
                except (ValueError, TypeError):
                    pass
            offset += batch_size

        sorted_topics = sorted(topic_freq.items(), key=lambda x: x[1], reverse=True)[:15]
        out({"ok": True, "total": total, "by_type": type_counts, "by_source": source_counts,
             "topics": sorted_topics, "oldest_ts": oldest_ts, "newest_ts": newest_ts})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_prune_old(args):
    """
    Remove low-value exchange entries older than N days.
    Structured facts (learned/identity/preference/project/synthesis) are NEVER pruned.
    """
    import time as _time
    try:
        days       = int(args.get("days", 60))
        min_len    = int(args.get("min_content_len", 120))
        dry_run    = args.get("dry_run", False)
        cutoff_ts  = int(_time.time()) - (days * 86400)
        client     = get_client()
        col        = get_collection(client)
        total      = col.count()
        SAFE_TYPES = {"learned", "identity", "preference", "project", "synthesis",
                      "session_summary", "retrospective", "codebase", "codebase_deep", "knowledge"}
        to_delete  = []
        batch_size = 200
        offset     = 0

        while offset < total:
            res = col.get(limit=batch_size, offset=offset,
                          include=["documents", "metadatas", "ids"])
            if not res or not res.get("documents"):
                break
            for i, doc in enumerate(res["documents"]):
                meta  = res["metadatas"][i] if res.get("metadatas") else {}
                rid   = res["ids"][i] if res.get("ids") else ""
                mtype = meta.get("type", "exchange")
                try:
                    mts = int(meta.get("ts", "0"))
                except (ValueError, TypeError):
                    mts = 0
                if mtype in SAFE_TYPES:
                    continue
                if mts > cutoff_ts:
                    continue
                if len(doc) >= min_len:
                    continue
                to_delete.append(rid)
            offset += batch_size

        if not dry_run and to_delete:
            for i in range(0, len(to_delete), 50):
                try:
                    col.delete(ids=to_delete[i:i+50])
                except Exception:
                    pass

        out({"ok": True, "pruned": len(to_delete), "dry_run": dry_run,
             "remaining": col.count(), "cutoff_days": days})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_import_conversations(args):
    """
    Bulk-import conversation history: [{role, content, ts}]
    """
    import hashlib, time as _time
    try:
        entries  = args.get("entries", [])
        if not entries:
            out({"ok": False, "error": "no entries provided"})
            return
        client   = get_client()
        col      = get_collection(client)
        imported = 0
        skipped  = 0

        for entry in entries:
            content = (entry.get("content") or "").strip()
            role    = entry.get("role", "user")
            ts      = entry.get("ts", int(_time.time()))
            if len(content) < 30:
                skipped += 1
                continue
            doc_id  = "import_" + hashlib.md5(content[:200].encode()).hexdigest()[:12]
            meta    = {"type": "exchange", "role": role, "ts": str(int(ts)), "source": "import"}
            try:
                col.upsert(documents=[content], metadatas=[meta], ids=[doc_id])
                imported += 1
            except Exception:
                skipped += 1

        out({"ok": True, "imported": imported, "skipped": skipped, "total": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})



def cmd_topics(args):
    """
    Returns all stored topic_checkpoint labels — the actual verified topics
    SCAAI has explicit memory of from past sessions. Honest memory list only.
    """
    try:
        client = get_client()
        col    = get_collection(client)
        if col.count() == 0:
            out({"ok": True, "topics": [], "total": 0})
            return
        res = col.get(limit=500, include=["documents", "metadatas", "ids"])
        topics = []
        seen_labels = set()
        if res and res.get("documents"):
            for i, doc in enumerate(res["documents"]):
                meta   = res["metadatas"][i] if res.get("metadatas") else {}
                source = meta.get("source", "")
                tags   = str(meta.get("tags", ""))
                if source != "topic_continuity" and "topic_checkpoint" not in tags:
                    continue
                label = ""
                for line in doc.strip().split("\n")[:3]:
                    if line.startswith("[TOPIC_CHECKPOINT:"):
                        label = line[len("[TOPIC_CHECKPOINT:"):].rstrip("]").strip()
                        break
                if not label:
                    label = meta.get("label", "").replace("topic_chk_", "").replace("_", " ").strip()
                if not label or label in seen_labels:
                    continue
                seen_labels.add(label)
                status  = "unknown"
                summary = ""
                for line in doc.strip().split("\n"):
                    if line.startswith("Status:"):
                        status = line[7:].strip()
                    if line.startswith("What we discussed:") and not summary:
                        summary = line[len("What we discussed:"):].strip()[:120]
                    elif line.startswith("Where we left off:") and not summary:
                        summary = line[len("Where we left off:"):].strip()[:120]
                topics.append({"label": label, "status": status,
                                "ts": meta.get("ts", "0"), "summary": summary})
        topics.sort(key=lambda x: x.get("ts", "0"), reverse=True)
        out({"ok": True, "topics": topics, "total": col.count()})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_graph_store(args):
    """
    Store nodes and edges in the Knowledge Graph DB.
    """
    try:
        nodes = args.get("nodes", [])  # [{"id": "...", "label": "...", "type": "..."}]
        edges = args.get("edges", [])  # [{"source": "...", "target": "...", "relation": "..."}]
        if not nodes and not edges:
            out({"ok": False, "error": "No nodes or edges provided"})
            return
        
        conn = init_graph_db()
        c = conn.cursor()
        ts_now = int(time.time())
        
        stored_nodes = 0
        stored_edges = 0
        
        for n in nodes:
            nid = n.get("id")
            label = n.get("label", "")
            ntype = n.get("type", "entity")
            if not nid: continue
            c.execute("INSERT OR REPLACE INTO entities (id, label, type) VALUES (?, ?, ?)", (nid, label, ntype))
            stored_nodes += 1
            
        for e in edges:
            src = e.get("source")
            tgt = e.get("target")
            rel = e.get("relation", "related_to")
            if not src or not tgt: continue
            c.execute("INSERT OR REPLACE INTO edges (source, target, relation, ts) VALUES (?, ?, ?, ?)", (src, tgt, rel, ts_now))
            stored_edges += 1
            
        conn.commit()
        conn.close()
        out({"ok": True, "nodes": stored_nodes, "edges": stored_edges})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_graph_query(args):
    """
    Query the Knowledge Graph DB by node IDs or exact labels to find 1-hop connected nodes.
    """
    try:
        query_ids = args.get("ids", [])
        conn = init_graph_db()
        c = conn.cursor()
        
        results = {"nodes": {}, "edges": []}
        
        for qid in query_ids:
            c.execute("SELECT id, label, type FROM entities WHERE id = ? OR label LIKE ?", (qid, f'%{qid}%'))
            rows = c.fetchall()
            for row in rows:
                match_id = row[0]
                results["nodes"][match_id] = {"id": row[0], "label": row[1], "type": row[2]}
                
                c.execute("SELECT source, target, relation, ts FROM edges WHERE source = ? OR target = ?", (match_id, match_id))
                edges = c.fetchall()
                for src, tgt, rel, edge_ts in edges:
                    results["edges"].append({"source": src, "target": tgt, "relation": rel, "ts": edge_ts})
                    if src not in results["nodes"]:
                        c.execute("SELECT id, label, type FROM entities WHERE id = ?", (src,))
                        srow = c.fetchone()
                        if srow: results["nodes"][src] = {"id": srow[0], "label": srow[1], "type": srow[2]}
                    if tgt not in results["nodes"]:
                        c.execute("SELECT id, label, type FROM entities WHERE id = ?", (tgt,))
                        trow = c.fetchone()
                        if trow: results["nodes"][tgt] = {"id": trow[0], "label": trow[1], "type": trow[2]}
                    
        conn.close()
        # Deduplicate edges just in case
        unique_edges = []
        seen_edges = set()
        for edge in results["edges"]:
            sig = f'{edge["source"]}->{edge["target"]}:{edge["relation"]}'
            if sig not in seen_edges:
                seen_edges.add(sig)
                unique_edges.append(edge)
                
        out({"ok": True, "nodes": list(results["nodes"].values()), "edges": unique_edges})
    except Exception as e:
        out({"ok": False, "error": str(e)})

def cmd_graph_all(args):
    """
    Retrieve the entire Knowledge Graph.
    """
    try:
        conn = init_graph_db()
        c = conn.cursor()
        c.execute("SELECT id, label, type FROM entities")
        nodes_rows = c.fetchall()
        nodes = [{"id": r[0], "label": r[1], "type": r[2]} for r in nodes_rows]
        
        c.execute("SELECT source, target, relation, ts FROM edges")
        edges_rows = c.fetchall()
        edges = [{"source": r[0], "target": r[1], "relation": r[2], "ts": r[3]} for r in edges_rows]
        
        conn.close()
        out({"ok": True, "nodes": nodes, "edges": edges})
    except Exception as e:
        out({"ok": False, "error": str(e)})

# ═══════════════════════════════════════════════════════════════════════════════
# ALGORITHMIC GRAPH INTELLIGENCE COMMANDS
# These power the autonomous cognitive engine — no LLM needed.
# ═══════════════════════════════════════════════════════════════════════════════

def cmd_graph_centrality(args):
    """
    Compute importance scores for all entities using degree centrality
    weighted by recency and access frequency.

    Algorithm:
      importance = (degree_centrality * 0.4) + (recency_score * 0.3) + (access_score * 0.3)

    Returns top-N entities ranked by importance.
    """
    try:
        n = int(args.get("n", 20))
        conn = init_graph_db()
        c = conn.cursor()

        # Get all entities
        c.execute("SELECT id, label, type, access_count, last_accessed, importance FROM entities")
        entities = {}
        for row in c.fetchall():
            entities[row[0]] = {
                "id": row[0], "label": row[1], "type": row[2],
                "access_count": row[3] or 0, "last_accessed": row[4] or 0,
                "importance": row[5] or 0.0,
            }

        if not entities:
            conn.close()
            out({"ok": True, "ranked": [], "total": 0})
            return

        # Compute degree centrality (number of edges per entity)
        degree = {eid: 0 for eid in entities}
        c.execute("SELECT source, target FROM edges")
        edge_count = 0
        for src, tgt in c.fetchall():
            edge_count += 1
            if src in degree: degree[src] += 1
            if tgt in degree: degree[tgt] += 1

        max_degree = max(degree.values()) if degree else 1
        now = int(time.time())
        day_seconds = 86400

        ranked = []
        for eid, ent in entities.items():
            # Degree centrality normalized [0,1]
            dc = degree.get(eid, 0) / max(max_degree, 1)

            # Recency score: exponential decay, 14-day half-life
            last_acc = ent["last_accessed"] or 0
            age_days = max((now - last_acc) / day_seconds, 0) if last_acc > 0 else 999
            half_life = 14.0
            recency = 2 ** (-age_days / half_life) if age_days < 999 else 0.01

            # Access frequency score (log scale to prevent domination)
            import math
            acc = ent["access_count"] or 0
            access_score = min(math.log2(acc + 1) / 10.0, 1.0)

            # Composite importance
            importance = (dc * 0.4) + (recency * 0.3) + (access_score * 0.3)

            # Persist computed importance back
            c.execute("UPDATE entities SET importance = ? WHERE id = ?", (round(importance, 4), eid))

            ranked.append({
                "id": eid, "label": ent["label"], "type": ent["type"],
                "importance": round(importance, 4),
                "degree": degree.get(eid, 0),
                "access_count": acc,
                "recency": round(recency, 4),
            })

        conn.commit()
        conn.close()

        ranked.sort(key=lambda x: x["importance"], reverse=True)
        out({"ok": True, "ranked": ranked[:n], "total": len(ranked), "edge_count": edge_count})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_graph_cluster(args):
    """
    Detect knowledge clusters using connected component analysis.
    Each cluster represents a domain the system has built understanding in.

    Algorithm: Union-Find on entity graph → connected components.
    Each cluster gets a label from its highest-importance member.
    """
    try:
        conn = init_graph_db()
        c = conn.cursor()

        c.execute("SELECT id, label, type, importance FROM entities")
        entities = {}
        for row in c.fetchall():
            entities[row[0]] = {"id": row[0], "label": row[1], "type": row[2], "importance": row[3] or 0.0}

        if not entities:
            conn.close()
            out({"ok": True, "clusters": [], "total_entities": 0})
            return

        # Union-Find
        parent = {eid: eid for eid in entities}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]  # path compression
                x = parent[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        c.execute("SELECT source, target FROM edges")
        for src, tgt in c.fetchall():
            if src in entities and tgt in entities:
                union(src, tgt)

        conn.close()

        # Group into clusters
        clusters_map = {}
        for eid in entities:
            root = find(eid)
            if root not in clusters_map:
                clusters_map[root] = []
            clusters_map[root].append(entities[eid])

        # Build cluster summaries
        clusters = []
        for root, members in clusters_map.items():
            members.sort(key=lambda x: x["importance"], reverse=True)
            top = members[0]
            # Cluster label = most important entity's label
            cluster_label = top["label"]
            # Cluster type = most common type among members
            type_counts = {}
            for m in members:
                t = m.get("type", "Concept")
                type_counts[t] = type_counts.get(t, 0) + 1
            dominant_type = max(type_counts, key=type_counts.get) if type_counts else "Concept"

            clusters.append({
                "label": cluster_label,
                "dominant_type": dominant_type,
                "size": len(members),
                "importance": round(sum(m["importance"] for m in members) / len(members), 4),
                "members": [m["label"] for m in members[:10]],  # top 10 by importance
            })

        clusters.sort(key=lambda x: x["importance"], reverse=True)
        out({"ok": True, "clusters": clusters, "total_entities": len(entities)})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_graph_decay(args):
    """
    Apply time-based decay to entity importance scores.
    Uses a 14-day half-life: importance *= 2^(-age_days / 14).

    Profile-type entities (Person, Identity) are EXEMPT from decay.
    Runs as a background maintenance task.
    """
    try:
        half_life = float(args.get("half_life_days", 14.0))
        exempt_types = set(args.get("exempt_types", ["Person", "Identity", "User"]))
        conn = init_graph_db()
        c = conn.cursor()

        now = int(time.time())
        day_seconds = 86400

        c.execute("SELECT id, type, last_accessed, importance FROM entities")
        updated = 0
        for eid, etype, last_acc, importance in c.fetchall():
            if etype in exempt_types:
                continue  # never decay profile facts
            if not last_acc or last_acc == 0:
                continue  # never accessed = already at baseline

            age_days = max((now - last_acc) / day_seconds, 0)
            import math
            decay_factor = 2 ** (-age_days / half_life)
            new_importance = (importance or 0.0) * decay_factor

            if abs(new_importance - (importance or 0.0)) > 0.001:
                c.execute("UPDATE entities SET importance = ? WHERE id = ?",
                          (round(new_importance, 4), eid))
                updated += 1

        conn.commit()
        conn.close()
        out({"ok": True, "updated": updated, "half_life_days": half_life})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_graph_boost(args):
    """
    Reinforce entities that were just accessed/mentioned.
    Increments access_count and updates last_accessed timestamp.
    Also boosts connected edges.

    This is the "remembering" algorithm — frequently accessed
    entities naturally rise in importance over time.
    """
    try:
        entity_ids = args.get("ids", [])
        if not entity_ids:
            out({"ok": False, "error": "no entity ids provided"})
            return

        conn = init_graph_db()
        c = conn.cursor()
        now = int(time.time())
        boosted = 0

        for eid in entity_ids:
            c.execute(
                "UPDATE entities SET access_count = access_count + 1, last_accessed = ? WHERE id = ?",
                (now, eid)
            )
            if c.rowcount > 0:
                boosted += 1

            # Also boost connected edges
            c.execute(
                "UPDATE edges SET access_count = access_count + 1 WHERE source = ? OR target = ?",
                (eid, eid)
            )

        conn.commit()
        conn.close()
        out({"ok": True, "boosted": boosted, "total_ids": len(entity_ids)})
    except Exception as e:
        out({"ok": False, "error": str(e)})


def cmd_graph_traverse(args):
    """
    Deep graph traversal: 1-hop and 2-hop neighbors with weighted scoring.
    Returns entities ranked by combined proximity + importance.

    This replaces the simple graph_query for cognitive use:
    given seed entities, find the most relevant connected knowledge.
    """
    try:
        seed_ids = args.get("ids", [])
        seed_labels = args.get("labels", [])
        max_results = int(args.get("n", 20))

        conn = init_graph_db()
        c = conn.cursor()

        # Resolve labels to IDs
        resolved_ids = set(seed_ids)
        for label in seed_labels:
            c.execute("SELECT id FROM entities WHERE label LIKE ?", (f'%{label}%',))
            for row in c.fetchall():
                resolved_ids.add(row[0])

        if not resolved_ids:
            conn.close()
            out({"ok": True, "results": [], "seeds_found": 0})
            return

        # 1-hop neighbors
        hop1 = {}  # entity_id -> {entity_data, hop_distance, edge_relation}
        for seed in resolved_ids:
            c.execute("SELECT source, target, relation, weight FROM edges WHERE source = ? OR target = ?", (seed, seed))
            for src, tgt, rel, weight in c.fetchall():
                neighbor = tgt if src == seed else src
                if neighbor in resolved_ids:
                    continue  # skip seeds themselves
                edge_weight = weight or 1.0
                if neighbor not in hop1 or hop1[neighbor]["score"] < edge_weight:
                    hop1[neighbor] = {"hop": 1, "relation": rel, "score": edge_weight, "via": seed}

        # 2-hop neighbors (neighbors of 1-hop neighbors)
        hop2 = {}
        for h1_id in list(hop1.keys())[:30]:  # limit fan-out
            c.execute("SELECT source, target, relation, weight FROM edges WHERE source = ? OR target = ?", (h1_id, h1_id))
            for src, tgt, rel, weight in c.fetchall():
                neighbor = tgt if src == h1_id else src
                if neighbor in resolved_ids or neighbor in hop1:
                    continue
                edge_weight = (weight or 1.0) * 0.5  # diminish for 2nd hop
                if neighbor not in hop2 or hop2[neighbor]["score"] < edge_weight:
                    hop2[neighbor] = {"hop": 2, "relation": rel, "score": edge_weight, "via": h1_id}

        # Fetch entity data for all discovered nodes
        all_ids = list(hop1.keys()) + list(hop2.keys())
        results = []
        for eid in all_ids:
            c.execute("SELECT id, label, type, importance, access_count FROM entities WHERE id = ?", (eid,))
            row = c.fetchone()
            if not row:
                continue
            hop_data = hop1.get(eid) or hop2.get(eid)
            combined_score = (hop_data["score"] * 0.5) + ((row[3] or 0.0) * 0.5)
            results.append({
                "id": row[0], "label": row[1], "type": row[2],
                "importance": row[3] or 0.0,
                "hop": hop_data["hop"],
                "relation": hop_data["relation"],
                "via": hop_data["via"],
                "combined_score": round(combined_score, 4),
            })

        conn.close()
        results.sort(key=lambda x: x["combined_score"], reverse=True)
        out({"ok": True, "results": results[:max_results], "seeds_found": len(resolved_ids),
             "hop1_count": len(hop1), "hop2_count": len(hop2)})
    except Exception as e:
        out({"ok": False, "error": str(e)})


# ── Module-level entrypoint ──
cmd, args = parse_args()
if not cmd:
    out({"ok": False, "error": "no command"})
    sys.exit(1)
_dispatch = {
    "init":                  cmd_init,
    "search":                lambda: cmd_search(args),
    "store":                 lambda: cmd_store(args),
    "stats":                 cmd_stats,
    "recall":                lambda: cmd_recall(args),
    "learn":                 lambda: cmd_learn(args),
    "forget":                lambda: cmd_forget(args),
    "delete":                lambda: cmd_forget(args),
    "list_all":              lambda: cmd_list_all(args),
    "ingest":                lambda: cmd_ingest(args),
    "recall_by_date":        lambda: cmd_recall_by_date(args),
    "analyze":               lambda: cmd_analyze(args),
    "deep_analyze":          lambda: cmd_deep_analyze(args),
    "embedding_check":       cmd_embedding_check,
    "health":                cmd_health,
    "prune_old":             lambda: cmd_prune_old(args),
    "import_conversations":  lambda: cmd_import_conversations(args),
    "topics":                lambda: cmd_topics(args),
    "graph_store":           lambda: cmd_graph_store(args),
    "graph_query":           lambda: cmd_graph_query(args),
    "graph_all":             lambda: cmd_graph_all(args),
    # ── Algorithmic Graph Intelligence ──
    "graph_centrality":      lambda: cmd_graph_centrality(args),
    "graph_cluster":         lambda: cmd_graph_cluster(args),
    "graph_decay":           lambda: cmd_graph_decay(args),
    "graph_boost":           lambda: cmd_graph_boost(args),
    "graph_traverse":        lambda: cmd_graph_traverse(args),
}
_fn = _dispatch.get(cmd)
if _fn:
    _fn()
else:
    out({"ok": False, "error": "unknown command: " + cmd})
