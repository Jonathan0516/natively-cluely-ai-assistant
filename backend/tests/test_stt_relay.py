from app.services.stt_relay import audio_seconds_for, build_deepgram_url


def test_audio_seconds_for_linear16_mono():
    # 32000 bytes @ 16000Hz mono 16-bit = 1.0s
    assert audio_seconds_for(32000, 16000, 1) == 1.0


def test_audio_seconds_for_zero_denominator_is_safe():
    assert audio_seconds_for(1000, 0, 1) == 0.0


def test_build_deepgram_url_encodes_params():
    url = build_deepgram_url("wss://api.deepgram.com/v1/listen",
                             {"encoding": "linear16", "sample_rate": "16000", "model": "nova-2"})
    assert url.startswith("wss://api.deepgram.com/v1/listen?")
    assert "encoding=linear16" in url
    assert "sample_rate=16000" in url
    assert "model=nova-2" in url
