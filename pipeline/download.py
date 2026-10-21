"""Download and unpack MovieLens ml-32m into data/raw (git-ignored).

    python -m pipeline.download
"""

from __future__ import annotations

import logging
import sys
import zipfile
from pathlib import Path

import certifi
import requests

from .config import Config

URL = "https://files.grouplens.org/datasets/movielens/ml-32m.zip"
# files.grouplens.org chains to emSign ECC Root CA - G3, which certifi dropped in 2026.10.19.
EXTRA_ROOTS = Path(__file__).parent / "certs" / "emsign-ecc-root-ca-g3.crt"
log = logging.getLogger("pipeline.download")


def ca_bundle(dest: Path) -> Path:
    """certifi's roots plus EXTRA_ROOTS, written to dest."""
    dest.write_text(
        Path(certifi.where()).read_text(encoding="utf-8") + "\n" + EXTRA_ROOTS.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    return dest


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    target = Config().movielens_dir
    if (target / "ratings.csv").exists():
        log.info("MovieLens already present at %s", target)
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    zip_path = target.parent / "ml-32m.zip"
    if not zip_path.exists():
        log.info("Downloading %s (~240 MB)", URL)
        verify = ca_bundle(target.parent / "ca-bundle.pem")
        with requests.get(URL, stream=True, timeout=60, verify=str(verify)) as r:
            r.raise_for_status()
            with open(zip_path, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(target.parent)
    extracted = target.parent / "ml-32m"
    if extracted != target and extracted.exists():
        extracted.rename(target)
    log.info("MovieLens ready at %s", target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
