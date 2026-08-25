from fastapi import APIRouter

from app.sync.api_admin import router_admin
from app.sync.api_protocol import router_protocol
from app.sync.api_webhook import router_webhook

router = APIRouter()
router.include_router(router_protocol)
router.include_router(router_admin)
router.include_router(router_webhook)
