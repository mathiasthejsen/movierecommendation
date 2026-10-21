from pathlib import Path

from pipeline.download import EXTRA_ROOTS, ca_bundle


def test_ca_bundle_includes_grouplens_root(tmp_path: Path) -> None:
    bundle = ca_bundle(tmp_path / "ca.pem").read_text(encoding="utf-8")
    assert "BEGIN CERTIFICATE" in EXTRA_ROOTS.read_text(encoding="utf-8")
    assert "emSign ECC Root CA - G3" in bundle
