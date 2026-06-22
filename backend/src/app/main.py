import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import auth, billing, embeddings, health, llm, meetings, modes, profile, stt, user_kv


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logging.basicConfig(level=settings.log_level)
    logger = logging.getLogger(__name__)
    logger.info(
        "starting backend env=%s aliyun_enabled=%s supabase_enabled=%s captcha_enabled=%s",
        settings.env,
        settings.aliyun_enabled,
        settings.supabase_enabled,
        settings.captcha_enabled,
    )
    if settings.jwt_secret.startswith("dev-only"):
        logger.warning("JWT_SECRET is the default dev secret — change it before production!")
    yield


app = FastAPI(title="Natively Backend", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def stamp_arrival(request, call_next):
    """Record request arrival before auth runs, so handlers can attribute the
    auth (get_current_user) round-trip in their own latency breakdowns."""
    import time

    request.state.t0 = time.perf_counter()
    return await call_next(request)


# CORS — the Electron renderer can show up as http://localhost:5173 (Vite dev),
# file:// (packaged), or app:// custom protocol. Allow all in dev; tighten in prod.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["*"],
)
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(meetings.router)
app.include_router(embeddings.router)
app.include_router(modes.router)
app.include_router(profile.router)
app.include_router(user_kv.router)
app.include_router(llm.router)
app.include_router(stt.router)
app.include_router(billing.router)
