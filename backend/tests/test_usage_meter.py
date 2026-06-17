from app.services.llm_types import QuotaStatus


def test_quota_remaining_and_exhausted():
    q = QuotaStatus(plan="free", period_start="a", period_end="b", credits_total=100, credits_used=30)
    assert q.credits_remaining == 70
    assert q.exhausted is False
    q2 = QuotaStatus(plan="free", period_start="a", period_end="b", credits_total=100, credits_used=100)
    assert q2.credits_remaining == 0
    assert q2.exhausted is True
