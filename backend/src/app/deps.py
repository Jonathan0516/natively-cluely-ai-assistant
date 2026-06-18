from functools import lru_cache
from typing import Annotated

import httpx
import jwt
from fastapi import Depends, Header, HTTPException, status

from .config import Settings, get_settings
from .services.aliyun_captcha import AliyunCaptchaVerifier, CaptchaVerifier, NoopCaptchaVerifier
from .services.aliyun_pnvs import AliyunPnvsSmsSender, MockSmsSender, SmsSender
from .services.data_repo import DataRepo, InMemoryDataRepo, SupabaseDataRepo
from .services.jwt_service import JwtService
from .services.llm_gateway import LLMGateway
from .services.model_catalog import CATALOG, PLANS
from .services.providers.openai_compat import OpenAICompatProvider
from .services.rate_limiter import InMemoryRateLimiter, RateLimiter
from .services.stt_relay import WebsocketsDeepgramUpstream
from .services.usage_meter import UsageMeter
from .services.usage_repo import InMemoryUsageRepo, SupabaseUsageRepo, UsageRepo
from .services.user_repo import InMemoryUserRepo, SupabaseUserRepo, User, UserRepo


@lru_cache
def get_sms_sender() -> SmsSender:
    settings: Settings = get_settings()
    if not settings.aliyun_enabled:
        return MockSmsSender()
    return AliyunPnvsSmsSender(
        access_key_id=settings.aliyun_access_key_id,
        access_key_secret=settings.aliyun_access_key_secret,
        sign_name=settings.aliyun_pnvs_sign_name,
        template_code=settings.aliyun_pnvs_template_code,
        valid_seconds=settings.aliyun_pnvs_code_valid_seconds,
        endpoint=settings.aliyun_pnvs_endpoint,
    )


@lru_cache
def get_user_repo() -> UserRepo:
    settings = get_settings()
    if not settings.supabase_enabled:
        return InMemoryUserRepo()
    return SupabaseUserRepo(
        url=settings.supabase_url, service_role_key=settings.supabase_service_role_key
    )


@lru_cache
def get_data_repo() -> DataRepo:
    settings = get_settings()
    if not settings.supabase_enabled:
        return InMemoryDataRepo()
    return SupabaseDataRepo(
        url=settings.supabase_url, service_role_key=settings.supabase_service_role_key
    )


@lru_cache
def get_rate_limiter() -> RateLimiter:
    # Single-process in-memory limiter. Swap for a Redis impl when running > 1 instance.
    return InMemoryRateLimiter()


@lru_cache
def get_captcha_verifier() -> CaptchaVerifier:
    settings = get_settings()
    if not settings.captcha_enabled:
        return NoopCaptchaVerifier()
    return AliyunCaptchaVerifier(
        access_key_id=settings.aliyun_access_key_id,
        access_key_secret=settings.aliyun_access_key_secret,
        scene_id=settings.aliyun_captcha_scene_id,
        endpoint=settings.aliyun_captcha_endpoint,
    )


@lru_cache
def get_jwt_service() -> JwtService:
    settings = get_settings()
    return JwtService(
        secret=settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
        access_ttl=settings.jwt_access_ttl_seconds,
        refresh_ttl=settings.jwt_refresh_ttl_seconds,
    )


async def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    repo: UserRepo = Depends(get_user_repo),
    jwt_svc: JwtService = Depends(get_jwt_service),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt_svc.verify(token, expected_type="access")
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token: {exc}") from exc
    user = await repo.get_by_id(payload["sub"])
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    return user


@lru_cache
def get_usage_repo() -> UsageRepo:
    settings = get_settings()
    if not settings.supabase_enabled:
        return InMemoryUsageRepo()
    return SupabaseUsageRepo(
        url=settings.supabase_url, service_role_key=settings.supabase_service_role_key
    )


def get_usage_meter(repo: UsageRepo = Depends(get_usage_repo)) -> UsageMeter:
    return UsageMeter(repo, CATALOG, PLANS)


class _OpenAICompatRouter:
    """Wraps per-spec base_url/key selection behind the single 'openai_compat' provider slot.
    Looks up the ModelSpec by upstream_model to pick the right base_url + platform key."""
    name = "openai_compat"

    def __init__(self, http: httpx.AsyncClient, settings):
        self._http = http
        self._settings = settings
        self._by_upstream = {
            s.upstream_model: s for s in CATALOG.values() if s.provider == "openai_compat"
        }

    def _provider_for(self, upstream_model: str) -> OpenAICompatProvider:
        spec = self._by_upstream[upstream_model]
        key = getattr(self._settings, spec.key_env, "")
        return OpenAICompatProvider(http=self._http, api_key=key, base_url=spec.base_url)

    def stream_chat(self, model, messages, images, params):
        return self._provider_for(model).stream_chat(model, messages, images, params)

    async def generate_json(self, model, messages, params):
        return await self._provider_for(model).generate_json(model, messages, params)

    async def embed(self, model, texts, dimensions=None):
        return await self._provider_for(model).embed(model, texts, dimensions)


@lru_cache
def get_llm_gateway() -> LLMGateway:
    settings = get_settings()
    http = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))
    # One OpenAI-compatible provider instance per distinct (base_url, key). The gateway
    # keys providers by ModelSpec.provider; for now all specs use "openai_compat", so we
    # build a single dispatching provider that picks base_url+key per upstream model.
    provider = _OpenAICompatRouter(http, settings)
    return LLMGateway(CATALOG, {"openai_compat": provider})


@lru_cache
def get_stt_upstream() -> WebsocketsDeepgramUpstream:
    settings = get_settings()
    return WebsocketsDeepgramUpstream(
        api_key=settings.deepgram_api_key,
        base_url="wss://api.deepgram.com/v1/listen",
    )
