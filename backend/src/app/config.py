from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    env: str = Field(default="dev")
    log_level: str = Field(default="INFO")

    supabase_sms_hook_secret: str = Field(default="")

    aliyun_access_key_id: str = Field(default="")
    aliyun_access_key_secret: str = Field(default="")
    aliyun_pnvs_endpoint: str = Field(default="dypnsapi.aliyuncs.com")
    # System-provided sign + template for the new "短信认证" product (no review needed).
    # Defaults match what Aliyun gives individual developers out of the box.
    aliyun_pnvs_sign_name: str = Field(default="速通互联验证码")
    aliyun_pnvs_template_code: str = Field(default="100001")
    aliyun_pnvs_code_valid_seconds: int = Field(default=300)

    # Captcha 2.0 — only available in cn-shanghai region.
    aliyun_captcha_scene_id: str = Field(default="")
    aliyun_captcha_endpoint: str = Field(default="captcha.cn-shanghai.aliyuncs.com")

    supabase_url: str = Field(default="")
    supabase_service_role_key: str = Field(default="")

    # Platform-held LLM/STT provider keys (gateway uses these; clients no longer hold keys).
    openai_api_key: str = Field(default="")
    gemini_api_key: str = Field(default="")
    anthropic_api_key: str = Field(default="")
    groq_api_key: str = Field(default="")
    netmind_api_key: str = Field(default="")
    deepgram_api_key: str = Field(default="")

    jwt_secret: str = Field(default="dev-only-do-not-use-in-prod-please-change-me")
    jwt_algorithm: str = Field(default="HS256")
    jwt_access_ttl_seconds: int = Field(default=3600)
    jwt_refresh_ttl_seconds: int = Field(default=60 * 60 * 24 * 30)

    stripe_secret_key: str = Field(default="")
    stripe_webhook_secret: str = Field(default="")

    @property
    def aliyun_enabled(self) -> bool:
        return bool(self.aliyun_access_key_id and self.aliyun_access_key_secret)

    @property
    def stripe_enabled(self) -> bool:
        return bool(self.stripe_secret_key)

    @property
    def supabase_enabled(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_role_key)

    @property
    def captcha_enabled(self) -> bool:
        return bool(
            self.aliyun_access_key_id and self.aliyun_access_key_secret and self.aliyun_captcha_scene_id
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
