from pydantic import BaseModel, EmailStr


class AccessToken(BaseModel):
    """Login & refresh return only the access token in the body;
    the refresh token travels in an httpOnly cookie, never in JSON."""

    access_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str