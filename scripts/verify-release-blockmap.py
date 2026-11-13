"""Verify electron-builder v2 gzip blockmaps against their installer bytes."""
import base64
import gzip
import hashlib
import json
import sys
from pathlib import Path


def verify_blockmap(artifact: Path, blockmap: Path) -> None:
    with gzip.open(blockmap, "rb") as stream:
        encoded = stream.read(32 * 1024 * 1024 + 1)
    if len(encoded) > 32 * 1024 * 1024:
        raise ValueError("blockmap exceeds the validation size limit")
    data = json.loads(encoded)
    files = data.get("files")
    if data.get("version") != "2" or not isinstance(files, list) or len(files) != 1:
        raise ValueError("unsupported blockmap format")
    entry = files[0]
    sizes, checksums = entry.get("sizes"), entry.get("checksums")
    if entry.get("name") != "file" or entry.get("offset") != 0 or not isinstance(sizes, list) or not isinstance(checksums, list) or len(sizes) != len(checksums):
        raise ValueError("invalid blockmap file coverage")
    with artifact.open("rb") as stream:
        for size, checksum in zip(sizes, checksums):
            if type(size) is not int or not 0 < size <= 32768:
                raise ValueError("invalid blockmap chunk size")
            chunk = stream.read(size)
            if len(chunk) != size or base64.b64encode(hashlib.blake2b(chunk, digest_size=18).digest()).decode("ascii") != checksum:
                raise ValueError("blockmap chunk hash differs from installer bytes")
        if stream.read(1):
            raise ValueError("blockmap does not cover the whole installer")


if __name__ == "__main__":
    try:
        verify_blockmap(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception:
        # Do not echo arbitrary blockmap contents or parser exception data.
        print("Blockmap validation failed", file=sys.stderr)
        sys.exit(1)
