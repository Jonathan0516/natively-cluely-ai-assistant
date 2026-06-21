# backend/src/app/services/llm_gateway.py
"""Provider-agnostic orchestration: resolve a logical model to its provider, run the
fallback chain, surface which spec actually served the request (for metering)."""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from .llm_types import ChatDelta, ChatMessage, EmbedResult, GenResult, NoModelAvailable
from .model_catalog import ModelSpec
from .providers.base import Provider

logger = logging.getLogger(__name__)


class LLMGateway:
    def __init__(self, catalog: dict[str, ModelSpec], providers: dict[str, Provider]):
        self._catalog = catalog
        self._providers = providers

    def resolve(self, model_id: str) -> tuple[ModelSpec, Provider]:
        spec = self._catalog.get(model_id)
        if not spec:
            raise NoModelAvailable(f"unknown model {model_id}")
        prov = self._providers.get(spec.provider)
        if not prov:
            raise NoModelAvailable(f"no provider for {spec.provider}")
        return spec, prov

    def _chain(self, model_id: str) -> list[str]:
        chain = [model_id]
        spec = self._catalog.get(model_id)
        if spec:
            chain.extend(f for f in spec.fallbacks if f in self._catalog)
        return chain

    async def generate_json(
        self, model_id: str, messages: list[ChatMessage], params: dict
    ) -> tuple[ModelSpec, GenResult]:
        errors = []
        for mid in self._chain(model_id):
            try:
                spec, prov = self.resolve(mid)
                res = await prov.generate_json(
                    spec.upstream_model, messages, {**spec.extra_params, **params}
                )
                return spec, res
            except Exception as exc:  # noqa: BLE001 — fallback is intentional
                logger.warning("generate_json %s failed: %s", mid, exc)
                errors.append(f"{mid}: {exc}")
        raise NoModelAvailable("; ".join(errors) or model_id)

    async def stream_chat(
        self, model_id: str, messages: list[ChatMessage], images: list[str], params: dict
    ) -> AsyncIterator[tuple[ModelSpec, ChatDelta]]:
        errors = []
        for mid in self._chain(model_id):
            try:
                spec, prov = self.resolve(mid)
                stream = prov.stream_chat(
                    spec.upstream_model, messages, images, {**spec.extra_params, **params}
                )
                # peek the first item so a provider that fails immediately can still fall back
                agen = stream.__aiter__()
                first = await agen.__anext__()
                yield spec, first
                async for delta in agen:
                    yield spec, delta
                return
            except StopAsyncIteration:
                return
            except Exception as exc:  # noqa: BLE001
                logger.warning("stream_chat %s failed: %s", mid, exc)
                errors.append(f"{mid}: {exc}")
        raise NoModelAvailable("; ".join(errors) or model_id)

    async def embed(
        self, model_id: str, texts: list[str]
    ) -> tuple[ModelSpec, EmbedResult]:
        spec, prov = self.resolve(model_id)  # NoModelAvailable for unknown model
        try:
            res = await prov.embed(spec.upstream_model, texts, spec.embed_dim or None)
        except Exception as exc:  # noqa: BLE001 — surface provider/upstream failure as a clean error
            logger.warning("embed %s failed: %s", model_id, exc)
            raise NoModelAvailable(f"{model_id}: {exc}") from exc
        return spec, res
