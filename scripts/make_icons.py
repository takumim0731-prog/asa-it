"""
アプリのアイコン（PNG）を作るスクリプト

デザイン: 緑の背景に、水平線から昇る朝日（「朝IT」の朝）。
外部ライブラリを使わず、Python標準の zlib と struct だけで PNG を書き出す。

使い方（プロジェクトのフォルダで実行）:
  python scripts/make_icons.py   → icons/icon-192.png と icons/icon-512.png ができる

Androidはアイコンを円や角丸に切り抜く（maskable）ので、絵は中心から半径40%の内側に収めている。
"""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "icons"

BG = (0x1F, 0x6F, 0x5C)     # 背景の緑（画面のアクセント色と同じ）
SUN = (0xF4, 0xB9, 0x42)    # 朝日の黄色
LINE = (0xFF, 0xFF, 0xFF)   # 水平線の白
SAMPLES = 4                 # ふちを滑らかにするため、1ピクセルを4×4に分けて色を平均する


def color_at(u: float, v: float) -> tuple[int, int, int]:
    """画像の中の位置（左上が0,0、右下が1,1）の色を返す"""
    # 朝日: 中心(0.5, 0.6)・半径0.2 の円の上半分
    if v < 0.6 and (u - 0.5) ** 2 + (v - 0.6) ** 2 < 0.2 ** 2:
        return SUN
    # 水平線: 長い線と短い線の2本（水面に映る光のイメージ）
    if 0.66 <= v <= 0.69 and abs(u - 0.5) <= 0.28:
        return LINE
    if 0.73 <= v <= 0.76 and abs(u - 0.5) <= 0.18:
        return LINE
    return BG


def render(size: int) -> bytes:
    rows = []
    for y in range(size):
        row = bytearray([0])  # 各行の先頭は「フィルタなし」を表す0
        for x in range(size):
            r = g = b = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    c = color_at((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size)
                    r += c[0]; g += c[1]; b += c[2]
            n = SAMPLES * SAMPLES
            row += bytes((r // n, g // n, b // n))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size: int) -> bytes:
    """PNGファイルの中身を組み立てる（署名 + IHDR + IDAT + IEND の各チャンク）"""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8bit・RGBカラー
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(render(size), 9))
        + chunk(b"IEND", b"")
    )


def main():
    OUT_DIR.mkdir(exist_ok=True)
    for size in (192, 512):
        path = OUT_DIR / f"icon-{size}.png"
        path.write_bytes(png(size))
        print(f"作成: {path}")


if __name__ == "__main__":
    main()
