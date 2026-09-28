from pipeline.extract import (
    Candidate,
    extract_candidate_titles,
    extract_seed_titles,
    load_llm_extractor,
    normalize_title,
    split_year,
)


def titles(cands):
    return [(c.title, c.year) for c in cands]


def test_normalize_title():
    assert normalize_title("The Matrix") == "matrix"
    assert normalize_title("Amélie") == "amelie"
    assert normalize_title("Lock, Stock & Two Smoking Barrels") == "lock stock and two smoking barrels"
    assert normalize_title("  Se7en!! ") == "se7en"


def test_split_year_variants():
    assert split_year("Primer (2004)") == Candidate("Primer", 2004)
    assert split_year("Primer [2004]") == Candidate("Primer", 2004)
    assert split_year("Primer, 2004") == Candidate("Primer", 2004)
    assert split_year("Blade Runner 2049") == Candidate("Blade Runner 2049", None)


def test_bold_titles():
    got = titles(extract_candidate_titles("**Coherence** is exactly it. Also **Timecrimes (2007)**."))
    assert got == [("Coherence", None), ("Timecrimes", 2007)]


def test_underscore_bold_and_italic():
    got = titles(extract_candidate_titles("Try __Enemy__ and *Mr. Nobody*, both great"))
    assert ("Enemy", None) in got
    assert ("Mr. Nobody", None) in got


def test_list_items_with_descriptions():
    body = "- Predestination\n* Triangle (2009) - a loop movie\n1. The Man from Earth: talky\n2) Cure"
    got = titles(extract_candidate_titles(body))
    assert got == [("Predestination", None), ("Triangle", 2009), ("The Man from Earth", None), ("Cure", None)]


def test_bold_inside_list_item_wins():
    got = titles(extract_candidate_titles("- **Moon** with Sam Rockwell is amazing and lonely"))
    assert got == [("Moon", None)]


def test_subtitles_and_small_words_are_kept():
    body = "- Mad Max: Fury Road\n- Stand by Me\n- Lock, Stock and Two Smoking Barrels, fun heist romp"
    got = titles(extract_candidate_titles(body))
    assert got == [("Mad Max: Fury Road", None), ("Stand by Me", None), ("Lock, Stock and Two Smoking Barrels", None)]


def test_inline_title_year_mentions():
    got = titles(extract_candidate_titles("You should see Oldboy (2003) if you haven't"))
    assert ("Oldboy", 2003) in got


def test_markdown_links_are_unwrapped():
    got = titles(extract_candidate_titles("**[Paprika](https://example.com/paprika)**"))
    assert got == [("Paprika", None)]


def test_short_comment_is_a_title():
    assert titles(extract_candidate_titles("In Bruges (2008)")) == [("In Bruges", 2008)]
    assert titles(extract_candidate_titles("Coherence")) == [("Coherence", None)]


def test_noise_is_filtered():
    assert extract_candidate_titles("**Edit:** thanks for the gold!") == []
    assert extract_candidate_titles("") == []
    long = "**" + "word " * 20 + "**"
    assert extract_candidate_titles(long) == []


def test_dedupe_prefers_year():
    got = titles(extract_candidate_titles("**Zodiac** ... seriously, Zodiac (2007)"))
    assert got == [("Zodiac", 2007)]


def test_seed_titles_movies_like():
    got = titles(extract_seed_titles("Movies like Donnie Darko and Primer?"))
    assert ("Donnie Darko", None) in got
    assert ("Primer", None) in got


def test_seed_titles_if_you_liked():
    got = titles(extract_seed_titles("If you liked The Silence of the Lambs, what should I watch next?"))
    assert got[0] == ("The Silence of the Lambs", None)


def test_seed_titles_keeps_whole_phrase_for_titles_with_and():
    got = titles(extract_seed_titles("Films like Lock, Stock and Two Smoking Barrels"))
    assert ("Lock, Stock and Two Smoking Barrels", None) in got


def test_seed_titles_slash_and_year():
    got = titles(extract_seed_titles("Something similar to Hereditary (2018) / The Witch"))
    assert ("Hereditary", 2018) in got
    assert ("The Witch", None) in got


def test_seed_titles_from_bold_in_body():
    got = titles(extract_seed_titles("Need recs", "I loved **Arrival** and want more"))
    assert got == [("Arrival", None)]


def test_seed_titles_none():
    assert extract_seed_titles("What did you watch this weekend?") == []


def test_llm_extractor_hook(monkeypatch, tmp_path):
    mod = tmp_path / "fake_llm.py"
    mod.write_text("def extract(text):\n    return ['Primer (2004)', ('Moon', 2009)]\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    fn = load_llm_extractor("fake_llm:extract")
    assert titles(fn("anything")) == [("Primer", 2004), ("Moon", 2009)]
    assert load_llm_extractor("") is None


# --- films vs series ---------------------------------------------------------------


def kinds(cands):
    return [(c.title, c.year, c.kind) for c in cands]


def test_tv_markers_and_year_ranges_mark_series():
    body = "- The Leftovers (TV)\n- Fargo (2014–2024)\n- Fargo (1996)\n- **Dark** (TV series)\n- Severance (2022-)"
    got = kinds(extract_candidate_titles(body))
    assert ("The Leftovers", None, "tv") in got
    assert ("Fargo", 2014, "tv") in got
    assert ("Fargo", 1996, None) in got  # the film stays separate from the series
    assert ("Dark", None, "tv") in got
    assert ("Severance", 2022, "tv") in got


def test_film_marker_marks_movie():
    got = kinds(extract_candidate_titles("If you want a film: **Coherence** (movie)"))
    assert got == [("Coherence", None, "movie")]


def test_thread_context_is_default_kind():
    got = kinds(extract_candidate_titles("**Mindhunter** and **Zodiac** (film)", kind="tv"))
    assert got == [("Mindhunter", None, "tv"), ("Zodiac", None, "movie")]


def test_seed_titles_detect_shows():
    got = kinds(extract_seed_titles("Shows like Breaking Bad?"))
    assert got == [("Breaking Bad", None, "tv")]
    got = kinds(extract_seed_titles("Movies like Donnie Darko"))
    assert got == [("Donnie Darko", None, "movie")]


def test_context_kind():
    from pipeline.extract import context_kind

    assert context_kind("Shows like Dark?") == "tv"
    assert context_kind("Films like Heat") == "movie"
    assert context_kind("Anything like Heat?") is None


# --- share / caption text ----------------------------------------------------------


def test_caption_inline_numbered_list_with_emoji():
    from pipeline.extract import extract_caption

    seeds, picks = extract_caption("Movies like Donnie Darko 🎬 1. Coherence (2013) 2. Primer")
    assert titles(seeds) == [("Donnie Darko", None)]
    assert titles(picks) == [("Coherence", 2013), ("Primer", None)]


def test_caption_hashtags_mentions_and_tv():
    from pipeline.extract import extract_caption

    text = "5 shows like Dark you need to binge 🔥\n1. Severance (2022-)\n2. **Twin Peaks** (TV series)\n#tv #mindbending @goosebumpscinema"
    seeds, picks = extract_caption(text)
    assert kinds(seeds) == [("Dark", None, "tv")]
    assert kinds(picks) == [("Severance", 2022, "tv"), ("Twin Peaks", None, "tv")]


def test_caption_bullets():
    from pipeline.extract import extract_caption

    _, picks = extract_caption("Hidden gems 👇\n• Blue Ruin (2013)\n• Cure (1997)\nSave this for later!")
    assert titles(picks) == [("Blue Ruin", 2013), ("Cure", 1997)]


def test_caption_single_line_seed_with_colon_list():
    from pipeline.extract import extract_caption

    seeds, picks = extract_caption("Shows like Stranger Things: **Dark** and Severance (2022-)")
    assert kinds(seeds) == [("Stranger Things", None, "tv")]
    assert kinds(picks) == [("Dark", None, "tv"), ("Severance", 2022, "tv")]
    _, plain = extract_caption("Movies like Heat: Thief, Collateral and Ronin")
    assert [c.title for c in plain] == ["Thief", "Collateral", "Ronin"]
    seeds, _ = extract_caption("Movies like Mad Max: Fury Road")
    assert seeds[0].title == "Mad Max: Fury Road"
