from app.core.config import settings
from app.discovery.agent_discovery_system import EnhancedAgentDiscoverySystem

prompt_file_path = [settings.PROMPT_FILE_PATH, settings.CLUSTER_PROMPT_FILE_PATH]

AgentDiscovery = EnhancedAgentDiscoverySystem(
    api_key=settings.DISCOVERY_LLM_API_KEY,
    base_url=settings.DISCOVERY_LLM_BASE_URL,
    model_name=settings.DISCOVERY_LLM_MODEL_NAME,
    prompt_file_path=prompt_file_path,
)
