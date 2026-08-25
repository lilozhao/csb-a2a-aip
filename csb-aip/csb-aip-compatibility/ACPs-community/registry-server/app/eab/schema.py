from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class EabCredentialResponse(BaseModel):
    key_id: str = Field(serialization_alias="keyId")
    mac_key: str = Field(serialization_alias="macKey")
    aic: str
    expires_at: datetime = Field(serialization_alias="expiresAt")

    model_config = ConfigDict(populate_by_name=True)


class EabConsumeRequest(BaseModel):
    key_id: str = Field(validation_alias="keyId")

    model_config = ConfigDict(populate_by_name=True)


class EabConsumeResponse(BaseModel):
    mac_key: str = Field(serialization_alias="macKey")
    aic: str

    model_config = ConfigDict(populate_by_name=True)
