#!/usr/bin/env python3
"""一次性数据迁移：把前端 public/ 下的库数据拆成后端可读的散落文件。

- 曲线库：frontend/public/曲线库/*.csv + manifest.json  ->  data/curves/
- EQ  库：frontend/public/eq库/eq-library.generated.js  ->  data/presets/*.json

EQ 库源文件由 Windows PowerShell 生成，存在双重编码损坏：原始 UTF-8 字节被
按 GBK 解读后再以 UTF-8 存储（例如 "我的EQ" 变成 "鎴戠殑EQ"）。
脚本对每条字符串尝试 gbk->utf-8 还原，失败则保持原样（正常中文不会误伤，
因为正常中文按 GBK 编码后不是合法 UTF-8，解码会抛异常）。

用法：python3 scripts/migrate_library.py
"""

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CURVE_SRC = ROOT / "frontend" / "public" / "曲线库"
EQ_SRC = ROOT / "frontend" / "public" / "eq库" / "eq-library.generated.js"
CURVE_DST = ROOT / "data" / "curves"
PRESET_DST = ROOT / "data" / "presets"

GLOBAL_KEY = "window.__EQ_PRESET_LIBRARY_DATA"
# 只处理含 CJK / 全角标点的字符串，纯 ASCII 不会是乱码
CJK_RE = re.compile(r"[\u2e80-\u9fff\uff00-\uffef]")
# 文件名非法字符
ILLEGAL_RE = re.compile(r'[\\/:*?"<>|\r\n\t]')


def fix_mojibake(value):
    """尝试还原双重编码损坏的字符串，返回 (结果, 是否被修复)。"""
    if not isinstance(value, str) or not value:
        return value, False
    if not CJK_RE.search(value):
        return value, False
    try:
        repaired = value.encode("gbk").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value, False
    if "\ufffd" in repaired:
        return value, False
    return repaired, repaired != value


def repair_tree(node, changes):
    """递归修复 JSON 结构中的所有字符串。"""
    if isinstance(node, str):
        fixed, changed = fix_mojibake(node)
        if changed:
            changes.append((node, fixed))
        return fixed
    if isinstance(node, list):
        return [repair_tree(item, changes) for item in node]
    if isinstance(node, dict):
        return {key: repair_tree(val, changes) for key, val in node.items()}
    return node


def safe_stem(name):
    stem = ILLEGAL_RE.sub("-", name).strip().strip(".")
    return stem or "unnamed"


def migrate_curves():
    if not CURVE_SRC.is_dir():
        sys.exit(f"找不到曲线库源目录：{CURVE_SRC}")
    CURVE_DST.mkdir(parents=True, exist_ok=True)

    copied = []
    for path in sorted(CURVE_SRC.glob("*.csv")):
        shutil.copy2(path, CURVE_DST / path.name)
        copied.append(path.name)

    manifest_src = CURVE_SRC / "manifest.json"
    if manifest_src.exists():
        # 源文件带 BOM，用 utf-8-sig 读取；重写为无 BOM 的 UTF-8
        data = json.loads(manifest_src.read_text(encoding="utf-8-sig"))
        (CURVE_DST / "manifest.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return copied


def migrate_presets():
    if not EQ_SRC.exists():
        sys.exit(f"找不到 EQ 库源文件：{EQ_SRC}")
    PRESET_DST.mkdir(parents=True, exist_ok=True)

    source = EQ_SRC.read_text(encoding="utf-8-sig")
    match = re.search(
        r"window\.__EQ_PRESET_LIBRARY_DATA\s*=\s*(\[.*\])\s*;?\s*$", source, re.S
    )
    if not match:
        sys.exit(f"无法从 {EQ_SRC.name} 中提取 {GLOBAL_KEY}")
    entries = json.loads(match.group(1))

    used = {}
    changes = []
    written = []      # 合法 JSON，已递归修复编码
    eqv1 = []         # EQv1 紧凑格式，引擎原生支持，保持原样
    broken = []       # 源文件中已损坏，无法解析，保持原样并报告

    for entry in entries:
        raw_name = entry.get("name") or "unnamed"
        name, _ = fix_mojibake(raw_name)

        text = entry.get("text") or ""
        try:
            payload = repair_tree(json.loads(text), changes)
            content = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
            bucket = written
        except json.JSONDecodeError:
            content = text if text.endswith("\n") else text + "\n"
            bucket = eqv1 if text.strip().startswith("EQv1") else broken

        stem = safe_stem(name)
        if stem in used:
            used[stem] += 1
            stem = f"{stem}-{used[stem]}"
        else:
            used[stem] = 0

        target = PRESET_DST / f"{stem}.json"
        target.write_text(content, encoding="utf-8")
        bucket.append(target.name)

    return written, eqv1, broken, changes


def main():
    curves = migrate_curves()
    presets, eqv1, broken, changes = migrate_presets()

    print(f"曲线库 -> data/curves/  共 {len(curves)} 个 CSV")
    for name in curves:
        print(f"  - {name}")
    if (CURVE_DST / "manifest.json").exists():
        print("  - manifest.json（已去除 BOM）")

    print(f"\nEQ 库   -> data/presets/")
    print(f"  合法 JSON（{len(presets)} 条）：")
    for name in presets:
        print(f"    - {name}")
    if eqv1:
        print(f"  EQv1 紧凑格式（{len(eqv1)} 条，引擎原生支持，保持原样）：")
        for name in eqv1:
            print(f"    - {name}")
    if broken:
        print(f"  源文件已损坏（{len(broken)} 条，保持原样，需人工修复）：")
        for name in broken:
            print(f"    - {name}")

    if changes:
        print(f"\n编码还原 {len(changes)} 处：")
        seen = set()
        for before, after in changes:
            if before in seen:
                continue
            seen.add(before)
            print(f'  "{before}" -> "{after}"')
    else:
        print("\n未发现需要还原的乱码。")


if __name__ == "__main__":
    main()
