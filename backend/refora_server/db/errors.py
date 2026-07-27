class RepoError(Exception):
    code: str
    field: str | None

    def __init__(self, code: str, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.name = "RepoError"
        self.code = code
        self.field = field
