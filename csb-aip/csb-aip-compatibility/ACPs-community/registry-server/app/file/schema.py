from pydantic import BaseModel


class FileResponse(BaseModel):
    """文件上传响应模型。"""

    orig_name: str
    file_path: str


class MultipleFileResponse(BaseModel):
    """多文件上传响应模型。"""

    files: list[FileResponse]
    count: int


class FileOperationResponse(BaseModel):
    """文件操作成功消息的响应模型。"""

    status: str
    message: str
