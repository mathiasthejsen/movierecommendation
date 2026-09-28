"""Download and unpack MovieLens ml-32m into data/raw (git-ignored).

    python -m pipeline.download
"""

from __future__ import annotations

import logging
import sys
import zipfile
from pathlib import Path

import requests

from .config import Config

URL = "https://files.grouplens.org/datasets/movielens/ml-32m.zip"
log = logging.getLogger("pipeline.download")


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
        with requests.get(URL, stream=True, timeout=60) as r:
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
