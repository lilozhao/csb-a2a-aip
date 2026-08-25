from typing import Annotated

from fastapi import APIRouter, Depends, File, Response, UploadFile, status

from app.account.model import RoleType, User
from app.core.auth import check_user_role, get_current_user
from app.core.base_exception import PROBLEM_JSON_MEDIA_TYPE
from app.file.exception import (
    FileAccessDeniedError,
    FileCleanupFailedError,
    FileDeleteFailedError,
    FileReadFailedError,
    FileUploadFailedError,
    StoredFileNotFoundError,
)
from app.file.schema import FileOperationResponse, FileResponse
from app.file.service import FileService

router = APIRouter(prefix="/file", tags=["file"])

type CurrentUserDep = Annotated[User, Depends(get_current_user)]
type MaintenanceUserDep = Annotated[User, Depends(check_user_role([RoleType.STAFF, RoleType.ADMIN]))]


def _problem_response(description: str) -> dict[str, object]:
    return {"description": description, "content": {PROBLEM_JSON_MEDIA_TYPE: {}}}


UNAUTHORIZED_RESPONSE = _problem_response("Authentication required")
FORBIDDEN_RESPONSE = _problem_response("File access denied")
NOT_FOUND_RESPONSE = _problem_response("Stored file not found")
VALIDATION_RESPONSE = _problem_response("Request validation failed")
SERVER_ERROR_RESPONSE = _problem_response("File operation failed")


@router.post(
    "/upload",
    status_code=status.HTTP_200_OK,
    summary="上传单个文件",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def upload_file(
    file: Annotated[UploadFile, File(...)],
    current_user: CurrentUserDep,
) -> FileResponse:
    """
    Upload a single file to the server.
    The file will be stored with a UUID name and marked as temporary.
    """
    try:
        relative_path = await FileService.save_uploaded_file(file)
        return FileResponse(orig_name=file.filename, file_path=relative_path)
    except OSError as e:
        raise FileUploadFailedError(
            detail=f"Error uploading file: {e!s}",
            input_params={"filename": file.filename},
        ) from None


@router.post(
    "/upload-multiple",
    status_code=status.HTTP_200_OK,
    summary="批量上传文件",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def upload_multiple_files(
    files: Annotated[list[UploadFile], File(...)],
    current_user: CurrentUserDep,
) -> list[FileResponse]:
    """
    Upload multiple files to the server.
    Each file will be stored with a UUID name and marked as temporary.
    """
    try:
        results = []
        for file in files:
            relative_path = await FileService.save_uploaded_file(file)
            results.append(FileResponse(orig_name=file.filename, file_path=relative_path))
        return results
    except OSError as e:
        raise FileUploadFailedError(
            detail=f"Error uploading files: {e!s}",
            input_params={"filenames": [file.filename for file in files]},
        ) from None


@router.delete(
    "/{file_path:path}",
    status_code=status.HTTP_200_OK,
    summary="删除指定文件",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def delete_file(
    file_path: str,
    current_user: CurrentUserDep,
) -> FileOperationResponse:
    """
    Delete a file from the server.
    """
    try:
        FileService.delete_file(file_path)
        return FileOperationResponse(
            status="success",
            message=f"File {file_path} deleted successfully",
        )
    except PermissionError as e:
        raise FileAccessDeniedError(file_path=file_path, detail=str(e)) from None
    except OSError as e:
        raise FileDeleteFailedError(file_path=file_path, detail=f"Error deleting file: {e!s}") from None


@router.post(
    "/cleanup",
    status_code=status.HTTP_200_OK,
    summary="清理过期临时文件",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def cleanup_temp_files(
    current_user: MaintenanceUserDep,
) -> FileOperationResponse:
    """
    Clean up temporary files older than 1 day.
    """
    try:
        count = FileService.cleanup_temp_files()
        return FileOperationResponse(status="success", message=f"Cleaned up {count} temporary files")
    except OSError as e:
        raise FileCleanupFailedError(detail=f"Error cleaning up files: {e!s}") from None


@router.get(
    "/{file_path:path}",
    status_code=status.HTTP_200_OK,
    summary="读取指定文件内容",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def get_file_content(
    file_path: str,
    current_user: CurrentUserDep,
) -> Response:
    """
    根据路径获取文件内容。

    Args:
        file_path: 文件的相对路径

    Returns:
        以流形式返回文件内容
    """
    del current_user
    try:
        content = FileService.read_file_content(file_path)
        # 尝试根据文件扩展名推断 MIME 类型
        import mimetypes

        mime_type, _ = mimetypes.guess_type(file_path)
        # 若无法推断 MIME 类型，则默认使用 application/octet-stream
        if mime_type is None:
            mime_type = "application/octet-stream"

        return Response(content=content, media_type=mime_type)
    except PermissionError as e:
        raise FileAccessDeniedError(file_path=file_path, detail=str(e)) from None
    except FileNotFoundError as e:
        raise StoredFileNotFoundError(file_path=file_path, detail=str(e)) from None
    except OSError as e:
        raise FileReadFailedError(file_path=file_path, detail=f"Error reading file: {e!s}") from None
